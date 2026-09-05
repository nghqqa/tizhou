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

// ---- 客观题答案保存控制器：与主观题控制器同一套数据安全保证 ----
// 快速连续选择只保留最新答案（中间版本不发送）；保存串行执行；
// 旧响应不覆盖新状态（调用方按 questionId 应用，本控制器保证回调有序）；
// 失败保留可重试；drain/destroy 供交卷前与组件卸载时使用。

export interface AnswerSaveRequest {
  examId: string
  questionId: string
  answer: string[]
}

export interface AnswerSaveOutcome {
  questionId: string
  ok: boolean
  error?: string
}

export class ExamAnswerSaveController {
  private queue: Promise<void> = Promise.resolve()
  /** questionId → 最新未保存答案（新答案覆盖旧答案，中间版本不发送） */
  private readonly latest = new Map<string, AnswerSaveRequest>()
  private readonly failed = new Map<string, AnswerSaveRequest>()
  private active = true

  constructor(
    private readonly saveFn: (request: AnswerSaveRequest) => Promise<void>,
    private readonly onSettled?: (outcome: AnswerSaveOutcome) => void
  ) {}

  /** 用户作答时调用：入队最新答案（同题重复调用自动去重为一次保存） */
  save(request: AnswerSaveRequest): void {
    if (!this.active) return
    this.latest.set(request.questionId, { ...request, answer: [...request.answer] })
    this.failed.delete(request.questionId)
    this.queue = this.queue.then(() => this.pump())
  }

  private async pump(): Promise<void> {
    while (this.active && this.latest.size > 0) {
      const firstKey = this.latest.keys().next().value
      if (firstKey === undefined) return
      const request = this.latest.get(firstKey)!
      this.latest.delete(firstKey)
      try {
        await this.saveFn(request)
        this.onSettled?.({ questionId: request.questionId, ok: true })
      } catch (error) {
        // 失败只进 failed（由用户重试/交卷 drain 驱动），不回 latest——
        // 否则 pump 会对同一失败请求无限重试
        this.failed.set(request.questionId, request)
        this.onSettled?.({
          questionId: request.questionId,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
        // 阻断后续保存避免连续失败风暴；下次 save/drain/retryAll 会重新驱动
        return
      }
    }
  }

  /** 交卷前调用：等待全部挂起保存完成；返回失败题列表（存在失败时交卷应被阻止） */
  async drain(): Promise<string[]> {
    let guard = 0
    while (this.latest.size > 0 && guard < 100) {
      await this.queue.catch(() => {})
      if (this.latest.size === 0) break
      // pump 因失败返回而停摆：重新驱动一次以处理期间新入队的答案
      this.queue = this.queue.then(() => this.pump())
      await this.queue.catch(() => {})
      guard += 1
    }
    return [...this.failed.keys()]
  }

  /** 串行重试全部失败题 */
  retryAll(): void {
    for (const request of this.failed.values()) this.save(request)
    this.failed.clear()
  }

  failedQuestionIds(): string[] {
    return [...this.failed.keys()]
  }

  get pendingCount(): number {
    return this.latest.size
  }

  /** 组件卸载时调用：尽量把挂起答案保存完成后再停止 */
  async destroy(): Promise<void> {
    await this.drain()
    this.active = false
  }
}
