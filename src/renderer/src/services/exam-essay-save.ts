/**
 * 模考主观题保存控制器：React 无关的串行化保存队列。
 *
 * 数据安全保证：
 * - 同一时刻最多一个 save 请求在执行
 * - 保存失败的数据保留在 failedSave，不丢弃
 * - flush() 返回是否有失败，交卷前检查
 * - retry() 重试失败保存，成功后才允许交卷
 * - markDirty() 捕获输入时的 questionId，切题不串写
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
  failedQuestionId?: string
}

export class EssaySaveController {
  private queue: Promise<void> = Promise.resolve()
  private pending: PendingEssaySave | null = null
  private failedSave: PendingEssaySave | null = null
  private revisionCounter = 0
  private readonly saveFn: (save: PendingEssaySave) => Promise<void>
  private readonly onStatusChange: (status: EssaySaveStatus) => void
  private active = true

  constructor(
    saveFn: (save: PendingEssaySave) => Promise<void>,
    onStatusChange: (status: EssaySaveStatus) => void
  ) {
    this.saveFn = saveFn
    this.onStatusChange = onStatusChange
  }

  /** 用户输入时标记脏：捕获当前 questionId，600ms 后由调用方触发 flushPending */
  markDirty(examId: string, questionId: string, text: string): void {
    if (!this.active) return
    this.revisionCounter += 1
    // 同一题多次输入只保留最新版本
    this.pending = {
      examId,
      questionId,
      answer: text ? [text] : [],
      revision: this.revisionCounter
    }
    this.onStatusChange('dirty')
  }

  /** 将 pendingSave 加入执行队列（不清除 failedSave） */
  async flushPending(): Promise<void> {
    if (!this.active || !this.pending) return
    const toSave = this.pending
    this.pending = null
    await this.enqueueSave(toSave)
  }

  /**
   * 等待所有保存完成，返回是否有失败。
   * 交卷前必须调用此方法并检查 hasFailure。
   */
  async drain(): Promise<SaveResult> {
    if (this.pending) await this.flushPending()
    await this.queue
    return this.getResult()
  }

  private getResult(): SaveResult {
    const failedSave: PendingEssaySave | null = this.failedSave
    if (failedSave instanceof Object) {
      return { hasFailure: true, failedQuestionId: failedSave.questionId }
    }
    return { hasFailure: false }
  }

  /** 重试失败的保存。成功后清除 failedSave。 */
  async retry(): Promise<SaveResult> {
    if (!this.failedSave) return { hasFailure: false }
    const toRetry = this.failedSave
    this.failedSave = null
    await this.enqueueSave(toRetry)
    await this.queue
    return this.getResult()
  }

  get hasFailedSave(): boolean {
    return this.failedSave !== null
  }

  get status(): EssaySaveStatus {
    if (this.failedSave) return 'error'
    if (this.pending) return 'dirty'
    return 'idle'
  }

  /** 组件卸载后停止接收新输入，已进入队列的保存继续完成 */
  destroy(): void {
    this.active = false
  }

  private async enqueueSave(save: PendingEssaySave): Promise<void> {
    this.onStatusChange('saving')
    this.queue = this.queue.then(async () => {
      try {
        await this.saveFn(save)
        this.onStatusChange('saved')
      } catch {
        this.failedSave = save
        this.onStatusChange('error')
      }
    })
    // 不 await this.queue here；让调用方通过 drain() 等待
  }
}
