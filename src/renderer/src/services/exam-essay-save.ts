/**
 * 模考主观题保存控制器：React 无关的串行化保存队列。
 *
 * 数据安全保证：
 * - 同一时刻最多一个 save 请求在执行
 * - 多题失败使用 Map 保留，不互相覆盖
 * - 同一题只保留最新 revision 的失败记录
 * - drain() 返回全部失败题 ID，交卷前检查
 * - retryAll() 串行重试所有失败项
 * - destroy() 前先 flush pending
 */

export type EssaySaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface PendingEssaySave {
  examId: string
  questionId: string
  answer: string[]
  revision: number
}

export interface SaveResult {
  hasFailure: boolean
  failedQuestionIds: string[]
  pendingCount: number
}

function saveKey(examId: string, questionId: string): string {
  return `${examId}\n${questionId}`
}

export class EssaySaveController {
  private queue: Promise<void> = Promise.resolve()
  private pending: PendingEssaySave | null = null
  private readonly failedSaves = new Map<string, PendingEssaySave>()
  private revisionCounter = 0
  private readonly saveFn: (save: PendingEssaySave) => Promise<void>
  private readonly onStatusChange: (status: EssaySaveStatus) => void
  private active = true
  private saving = false

  constructor(
    saveFn: (save: PendingEssaySave) => Promise<void>,
    onStatusChange: (status: EssaySaveStatus) => void
  ) {
    this.saveFn = saveFn
    this.onStatusChange = onStatusChange
  }

  /** 用户输入时标记脏：捕获当前 questionId */
  markDirty(examId: string, questionId: string, text: string): void {
    if (!this.active) return
    this.revisionCounter += 1
    this.pending = {
      examId,
      questionId,
      answer: text ? [text] : [],
      revision: this.revisionCounter
    }
    this.onStatusChange('dirty')
  }

  /** 将 pendingSave 加入执行队列 */
  async flushPending(): Promise<void> {
    if (!this.active || !this.pending) return
    const toSave = this.pending
    this.pending = null
    await this.enqueueSave(toSave)
  }

  /**
   * 等待所有保存完成，返回失败详情。
   * 交卷前必须调用此方法并检查 hasFailure。
   */
  async drain(): Promise<SaveResult> {
    if (this.pending) await this.flushPending()
    await this.queue
    return this.getResult()
  }

  /**
   * 重试所有失败的保存（串行执行）。
   * 同一题只保留最新 revision，不会覆盖已成功的新答案。
   */
  async retryAll(): Promise<SaveResult> {
    if (this.failedSaves.size === 0) return this.getResult()
    const toRetry = [...this.failedSaves.values()]
    this.failedSaves.clear()
    for (const save of toRetry) {
      await this.enqueueSave(save)
    }
    await this.queue
    return this.getResult()
  }

  /** 兼容旧 API */
  async retry(): Promise<SaveResult> {
    return this.retryAll()
  }

  get hasFailedSave(): boolean {
    return this.failedSaves.size > 0
  }

  get failedCount(): number {
    return this.failedSaves.size
  }

  get status(): EssaySaveStatus {
    if (this.failedSaves.size > 0) return 'error'
    if (this.saving) return 'saving'
    if (this.pending) return 'dirty'
    return 'idle'
  }

  /**
   * 组件卸载：先 flush pending（不丢数据），然后停止接收新输入。
   * 已进入队列的保存继续完成。
   */
  destroy(): Promise<void> {
    if (this.pending) {
      const toSave = this.pending
      this.pending = null
      void this.enqueueSave(toSave)
    }
    this.active = false
    return this.queue
  }

  private async enqueueSave(save: PendingEssaySave): Promise<void> {
    this.saving = true
    this.onStatusChange('saving')
    this.queue = this.queue.then(async () => {
      try {
        await this.saveFn(save)
        const key = saveKey(save.examId, save.questionId)
        const existing = this.failedSaves.get(key)
        if (existing && existing.revision <= save.revision) {
          this.failedSaves.delete(key)
        }
        if (this.failedSaves.size === 0 && !this.pending) {
          this.onStatusChange('saved')
        }
      } catch {
        const key = saveKey(save.examId, save.questionId)
        const existing = this.failedSaves.get(key)
        if (!existing || save.revision >= existing.revision) {
          this.failedSaves.set(key, save)
        }
        this.onStatusChange('error')
      } finally {
        this.saving = false
      }
    })
  }

  private getResult(): SaveResult {
    const failedQuestionIds: string[] = []
    for (const key of this.failedSaves.keys()) {
      const parts = key.split('\n')
      failedQuestionIds.push(parts[1] ?? '')
    }
    return {
      hasFailure: this.failedSaves.size > 0,
      failedQuestionIds,
      pendingCount: this.pending ? 1 : 0
    }
  }
}
