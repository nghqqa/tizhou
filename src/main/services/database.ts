import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AiConversation,
  AiMessage,
  AiTrainingRecord,
  AppSettings,
  AttemptInput,
  AttemptResult,
  BackupInfo,
  ConstructedAttemptRecord,
  ConstructedDraft,
  DashboardData,
  ExamAnswer,
  ExamConfig,
  ExamSession,
  KnowledgeDocument,
  LearnerMemory,
  LearningPlan,
  PaperProgressItem,
  PracticeSelection,
  PracticeSession,
  Question,
  QuestionFacets,
  QuestionLibraryItem,
  QuestionSummary,
  QuestionUserMeta,
  ReportData,
  ReviewItem,
  ShenlunPaperSummary,
  StudySnippet,
  Subject,
  VaultIndexResult,
  VaultInfo,
  VaultSnapshotInfo
} from '../../shared/contracts'
import { localDateKeyOf } from '../utils/common'
import * as analyticsRepo from './db/analytics-repo'
import {
  type QuestionListFilter,
  type Row,
  type VaultQueryCaches,
  runInTransaction
} from './db/mappers'
import { migrateDatabase, openDatabase } from './db/migrations'
import * as questionRepo from './db/question-repo'
import * as studyRepo from './db/study-repo'
import * as systemRepo from './db/system-repo'

export { localDateKeyOf }
export type { Row }

export class DatabaseService {
  private db: DatabaseSync
  private readonly caches: VaultQueryCaches = {
    facets: new Map(),
    shenlunQuality: null
  }

  constructor(
    readonly databasePath: string,
    readonly dataDirectory: string,
    readonly backupDirectory: string
  ) {
    mkdirSync(dataDirectory, { recursive: true })
    mkdirSync(backupDirectory, { recursive: true })
    this.db = openDatabase(this.databasePath)
    migrateDatabase(this.db)
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(operation: () => T): T {
    return runInTransaction(this.db, operation)
  }

  getSetting<T>(key: string, fallback: T): T {
    return systemRepo.getSetting(this.db, key, fallback)
  }

  setSetting<T>(key: string, value: T): void {
    systemRepo.setSetting(this.db, key, value)
  }

  getAppSettings(): AppSettings {
    return systemRepo.getAppSettings(this.db)
  }

  saveAppSettings(patch: Partial<AppSettings>): AppSettings {
    return systemRepo.saveAppSettings(this.db, patch)
  }

  upsertVault(vault: VaultInfo, active = true): void {
    questionRepo.upsertVault(this.db, vault, active)
  }

  getActiveVault(): VaultInfo | undefined {
    return questionRepo.getActiveVault(this.db)
  }

  listVaults(): VaultInfo[] {
    return questionRepo.listVaults(this.db)
  }

  switchVault(id: string): VaultInfo {
    return questionRepo.switchVault(this.db, id, this.caches)
  }

  clearActiveVaultWarnings(): void {
    questionRepo.clearActiveVaultWarnings(this.db)
  }

  listVaultQuestionIndexMeta(vaultId: string) {
    return questionRepo.listVaultQuestionIndexMeta(this.db, vaultId)
  }

  replaceVaultContent(
    vault: VaultInfo,
    questions: Array<
      | Question
      | {
          id: string
          contentHash: string
          filePath?: string
          fileMtimeMs?: number
          fileSize?: number
          _reused: true
        }
    >,
    documents: KnowledgeDocument[],
    captureSnapshot = true
  ): { added: number; updated: number; removed: number } {
    return questionRepo.replaceVaultContent(
      this.db,
      this.caches,
      vault,
      questions,
      documents,
      captureSnapshot
    )
  }

  listQuestionSummaries(filter: QuestionListFilter = {}): QuestionSummary[] {
    return questionRepo.listQuestionSummaries(this.db, this.caches, filter)
  }

  listQuestions(filter: QuestionListFilter = {}): Question[] {
    return questionRepo.listQuestions(this.db, filter)
  }

  /** 练习抽题池：与 listQuestions 同过滤，不设人为题量上限——
   *  超五万题的大型题库全库采样时也不因 LIMIT 截断而漏抽旧题 */
  listQuestionsForPool(filter: QuestionListFilter = {}): Question[] {
    return questionRepo.listQuestionsForPool(this.db, filter)
  }

  /** 原卷组卷专用：按 papers 复现记录取整卷题目并按卷内题号排序，
   *  不经 listQuestions 的 5000 截断（大题库的旧年份真题卷不能被截掉） */
  listQuestionsByPaper(paper: string): Question[] {
    return questionRepo.listQuestionsByPaper(this.db, paper)
  }

  getQuestion(id: string): Question | undefined {
    return questionRepo.getQuestion(this.db, id)
  }

  upsertSingleQuestion(vaultId: string, question: Question): void {
    questionRepo.upsertSingleQuestion(this.db, this.caches, vaultId, question)
  }

  /** 错题本 / 收藏夹 / 笔记库全景查询：限定当前活动知识库，支持按模块、顽固次数、错因与关键词过滤 */
  listQuestionLibrary(params: {
    tab: 'wrong' | 'favorite' | 'notes'
    category?: string
    categories?: string[]
    wrongCause?: string
    query?: string
    minWrongCount?: number
    limit?: number
  }): QuestionLibraryItem[] {
    return questionRepo.listQuestionLibrary(this.db, params)
  }

  /** 按题号顺序批量取题（用于模考错题重刷、全局检索直达单题），自动去重并保序 */
  getQuestionsByIds(ids: string[]): Question[] {
    return questionRepo.getQuestionsByIds(this.db, ids)
  }

  /** 批量获取题目用户元数据（收藏 / 笔记 / 最近错因），供模考复盘页一次 IPC 拉齐 */
  getQuestionsUserMeta(questionIds: string[]): Record<string, QuestionUserMeta> {
    return questionRepo.getQuestionsUserMeta(this.db, questionIds)
  }

  /** 更新错题的错因标注（仅对已入错题表或存在题目记录的题生效） */
  setWrongQuestionCause(questionId: string, wrongCause: string): void {
    questionRepo.setWrongQuestionCause(this.db, questionId, wrongCause)
  }

  listAiConversations(limit = 50): AiConversation[] {
    return systemRepo.listAiConversations(this.db, limit)
  }

  saveAiConversation(input: {
    id?: string
    title: string
    questionId?: string
    messages: AiMessage[]
  }): AiConversation {
    return systemRepo.saveAiConversation(this.db, input)
  }

  deleteAiConversation(id: string): void {
    systemRepo.deleteAiConversation(this.db, id)
  }

  listLearnerMemories(onlyEnabled = false): LearnerMemory[] {
    return systemRepo.listLearnerMemories(this.db, onlyEnabled)
  }

  saveLearnerMemory(input: {
    id?: string
    category: string
    content: string
    evidence?: string
    source?: 'agent' | 'user'
  }): LearnerMemory {
    return systemRepo.saveLearnerMemory(this.db, input)
  }

  toggleLearnerMemory(id: string, enabled: boolean): LearnerMemory {
    return systemRepo.toggleLearnerMemory(this.db, id, enabled)
  }

  deleteLearnerMemory(id: string): void {
    systemRepo.deleteLearnerMemory(this.db, id)
  }

  /** 整库题目一次取出（供快照与增量索引复用未变文件的记录） */
  listVaultQuestions(vaultId: string): Question[] {
    return questionRepo.listVaultQuestions(this.db, vaultId)
  }

  /** 汇总真题卷列表：每卷在当前活动知识库中的可用题量（联考共用题去重后按复现记录聚合）。
   *  题量不足 30 的卷不返回：与 exam.createPaper 的组卷校验及模考页描述保持同一口径 */
  listPapers(): Array<{ paper: string; count: number; year?: number }> {
    return questionRepo.listPapers(this.db)
  }

  listShenlunPapers(): ShenlunPaperSummary[] {
    return questionRepo.listShenlunPapers(this.db)
  }

  listShenlunQuestionsByPaper(paper: string): Question[] {
    return questionRepo.listShenlunQuestionsByPaper(this.db, paper)
  }

  listPaperProgressMatrix(subject?: Subject): PaperProgressItem[] {
    return questionRepo.listPaperProgressMatrix(this.db, subject)
  }

  /** 轻量去重签名：只取题干/材料/选项列，供题库导入前比对（8k+ 题秒级） */
  listQuestionSignatures(vaultId: string): string[] {
    return questionRepo.listQuestionSignatures(this.db, vaultId)
  }

  listDocuments(filter: { subject?: string; kind?: string; query?: string }): KnowledgeDocument[] {
    return questionRepo.listDocuments(this.db, filter)
  }

  listVaultSnapshots(vaultId: string): VaultSnapshotInfo[] {
    return questionRepo.listVaultSnapshots(this.db, vaultId)
  }

  rollbackVaultSnapshot(snapshotId: string): VaultIndexResult {
    return questionRepo.rollbackVaultSnapshot(this.db, this.caches, snapshotId)
  }

  listCategories(subject?: string): Array<{ name: string; count: number }> {
    return questionRepo.listCategories(this.db, subject)
  }

  getQuestionFacets(subject?: string, region?: string): QuestionFacets {
    return questionRepo.getQuestionFacets(this.db, this.caches, subject, region)
  }

  /** 对当前活动题库批量规整/补齐地区标签（不改文件、不改题目 ID） */
  normalizeActiveVaultRegions(): { updated: number } {
    return questionRepo.normalizeActiveVaultRegions(this.db, this.caches)
  }

  findSimilarQuestions(questionId: string, limit = 5): Question[] {
    return questionRepo.findSimilarQuestions(this.db, questionId, limit)
  }

  getRecentAttemptQuestionIds(limit = 100): string[] {
    return studyRepo.getRecentAttemptQuestionIds(this.db, limit)
  }

  getAttemptedQuestionIds(): Set<string> {
    return studyRepo.getAttemptedQuestionIds(this.db)
  }

  createPracticeSession(selection: PracticeSelection, questions: Question[]): PracticeSession {
    return studyRepo.createPracticeSession(this.db, selection, questions)
  }

  getActivePracticeSession(mode: 'practice' | 'review'): PracticeSession | undefined {
    return studyRepo.getActivePracticeSession(this.db, mode)
  }

  /** 会话已持久化的作答记录（汇总模式恢复时重建内存态结果用），按提交顺序返回 */
  getSessionAttempts(
    sessionId: string
  ): Array<{ questionId: string; answer: string[]; correct: boolean }> {
    return studyRepo.getSessionAttempts(this.db, sessionId)
  }

  updatePracticeSession(
    id: string,
    patch: { currentIndex?: number; uncertainIds?: string[]; appendQuestionIds?: string[] }
  ): PracticeSession {
    return studyRepo.updatePracticeSession(this.db, id, patch)
  }

  completePracticeSession(id: string, abandoned = false): PracticeSession {
    return studyRepo.completePracticeSession(this.db, id, abandoned)
  }

  submitAttempt(input: AttemptInput): AttemptResult {
    const result = studyRepo.submitAttempt(this.db, input)
    if (input.mode === 'practice' || input.mode === 'review') {
      const question = this.getQuestion(input.questionId)
      try {
        analyticsRepo.syncActivePlanProgress(this.db, {
          type: input.mode === 'review' ? 'official_review' : 'official_practice',
          category: question?.category,
          delta: 1
        })
      } catch {
        /* 计划联动异常不阻断作答提交主链路 */
      }
    }
    return result
  }

  rateReviewAttempt(params: {
    questionId: string
    feedback: 'forgot' | 'hard' | 'normal' | 'easy'
    baselineStreak?: number
    baselineStage?: number
  }) {
    return studyRepo.rateReviewAttempt(this.db, params)
  }

  enqueueReviewQuestions(questionIds: string[], reason?: string) {
    return studyRepo.enqueueReviewQuestions(this.db, questionIds, reason)
  }

  getActiveReviewQueueIds(questionIds: string[]): Set<string> {
    return studyRepo.getActiveReviewQueueIds(this.db, questionIds)
  }

  setFavorite(questionId: string, favorite: boolean): void {
    studyRepo.setFavorite(this.db, questionId, favorite)
  }

  isFavorite(questionId: string): boolean {
    return studyRepo.isFavorite(this.db, questionId)
  }

  saveNote(questionId: string, content: string): void {
    studyRepo.saveNote(this.db, questionId, content)
  }

  getNote(questionId: string): string {
    return studyRepo.getNote(this.db, questionId)
  }

  getDueReviews(limit = 100): ReviewItem[] {
    return studyRepo.getDueReviews(this.db, limit)
  }

  createExam(config: ExamConfig, questions: Question[]): ExamSession {
    return studyRepo.createExam(this.db, config, questions)
  }

  getActiveExam(): ExamSession | undefined {
    return studyRepo.getActiveExam(this.db)
  }

  saveExamAnswer(examId: string, answer: ExamAnswer): ExamSession {
    return studyRepo.saveExamAnswer(this.db, examId, answer)
  }

  finishExam(examId: string, uncertainIds?: string[]): ExamSession {
    return studyRepo.finishExam(this.db, examId, uncertainIds)
  }

  getExamById(id: string): ExamSession | undefined {
    return studyRepo.getExamById(this.db, id)
  }

  listExams(): ExamSession[] {
    return studyRepo.listExams(this.db)
  }

  saveDraft(draft: Omit<ConstructedDraft, 'updatedAt'>): ConstructedDraft {
    return studyRepo.saveDraft(this.db, draft)
  }

  getDraft(id: string): ConstructedDraft | undefined {
    return studyRepo.getDraft(this.db, id)
  }

  saveConstructedAttempt(payload: {
    id: string
    promptId: string
    title: string
    content: string
    evaluation: unknown
    createdAt: string
  }): void {
    studyRepo.saveConstructedAttempt(this.db, payload)
  }

  saveSelfCheckConstructed(input: {
    promptId: string
    title: string
    content: string
    hitPoints: string[]
    totalPoints: number
    score: number
  }): ConstructedAttemptRecord {
    return studyRepo.saveSelfCheckConstructed(this.db, input)
  }

  listConstructedAttempts(params?: {
    promptId?: string
    limit?: number
    range?: ReportData['range']
  }): ConstructedAttemptRecord[] {
    return studyRepo.listConstructedAttempts(this.db, params)
  }

  getConstructedAttemptSummary(
    range: ReportData['range'] = 'all'
  ): NonNullable<ReportData['essaySummary']> {
    return studyRepo.getConstructedAttemptSummary(this.db, range)
  }

  listStudySnippets(params?: { kind?: 'norm' | 'quote'; query?: string }): StudySnippet[] {
    return studyRepo.listStudySnippets(this.db, params)
  }

  saveStudySnippet(input: {
    id?: string
    kind: 'norm' | 'quote'
    title: string
    content: string
    sourceDocId?: string
    tags?: string[]
  }): StudySnippet {
    return studyRepo.saveStudySnippet(this.db, input)
  }

  deleteStudySnippet(id: string): boolean {
    return studyRepo.deleteStudySnippet(this.db, id)
  }

  getDashboard(): DashboardData {
    return analyticsRepo.getDashboard(this.db)
  }

  getReport(range: ReportData['range']): ReportData {
    return analyticsRepo.getReport(this.db, range)
  }

  savePlan(plan: LearningPlan): LearningPlan {
    return analyticsRepo.savePlan(this.db, plan)
  }

  getActivePlan(): LearningPlan | undefined {
    return analyticsRepo.getActivePlan(this.db)
  }

  completePlanItem(planId: string, itemId: string, completed: number): LearningPlan {
    return analyticsRepo.completePlanItem(this.db, planId, itemId, completed)
  }

  recordPlanRead(category?: string, minutes = 10): LearningPlan | undefined {
    return analyticsRepo.syncActivePlanProgress(this.db, {
      type: 'read_knowledge',
      category,
      delta: Math.max(1, Math.round(minutes))
    })
  }

  cancelPlan(planId: string): void {
    analyticsRepo.cancelPlan(this.db, planId)
  }

  getAiRecord(): Row | undefined {
    return systemRepo.getAiRecord(this.db)
  }

  saveAiRecord(
    payloadJson: string,
    encryptedKey: string | null,
    verified: boolean,
    lastCheckedAt?: string,
    lastError?: string
  ): void {
    systemRepo.saveAiRecord(this.db, payloadJson, encryptedKey, verified, lastCheckedAt, lastError)
  }

  clearAiCredential(): void {
    systemRepo.clearAiCredential(this.db)
  }

  getVlmRecord(): Row | undefined {
    return systemRepo.getVlmRecord(this.db)
  }

  saveVlmRecord(
    payloadJson: string,
    encryptedKey: string | null,
    verified: boolean,
    lastCheckedAt?: string,
    lastError?: string
  ): void {
    systemRepo.saveVlmRecord(this.db, payloadJson, encryptedKey, verified, lastCheckedAt, lastError)
  }

  clearVlmCredential(): void {
    systemRepo.clearVlmCredential(this.db)
  }

  saveAiTrainingRecord(
    input: Omit<AiTrainingRecord, 'id' | 'correct' | 'createdAt'>
  ): AiTrainingRecord {
    const record = systemRepo.saveAiTrainingRecord(this.db, input)
    try {
      analyticsRepo.syncActivePlanProgress(this.db, { type: 'ai_variant', delta: 1 })
    } catch {
      /* 计划联动异常不阻断变式训练记录 */
    }
    return record
  }

  listAiTrainingRecords(): AiTrainingRecord[] {
    return systemRepo.listAiTrainingRecords(this.db)
  }

  getIntegrationRecord(): Row | undefined {
    return systemRepo.getIntegrationRecord(this.db)
  }

  saveIntegrationRecord(payloadJson: string): void {
    systemRepo.saveIntegrationRecord(this.db, payloadJson)
  }

  createBackup(reason: BackupInfo['reason'] = 'manual'): BackupInfo {
    return systemRepo.createBackup(this.db, this.databasePath, this.backupDirectory, reason)
  }

  listBackups(): BackupInfo[] {
    return systemRepo.listBackups(this.backupDirectory)
  }

  restoreBackup(path: string): void {
    const resolved = this.listBackups().find((backup) => backup.path === path)
    if (!resolved) throw new Error('只能恢复由本应用创建且仍位于备份目录中的备份')
    systemRepo.validateBackup(resolved.path)
    const recovery = this.createBackup('pre-restore')
    this.db.close()
    try {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${this.databasePath}${suffix}`
        if (existsSync(sidecar)) unlinkSync(sidecar)
      }
      copyFileSync(resolved.path, this.databasePath)
      this.db = openDatabase(this.databasePath)
      migrateDatabase(this.db)
      if (this.integrityCheck() !== 'ok') throw new Error('恢复后的数据库完整性检查未通过')
      this.caches.facets.clear()
      this.caches.shenlunQuality = null
    } catch (error) {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${this.databasePath}${suffix}`
        if (existsSync(sidecar)) unlinkSync(sidecar)
      }
      copyFileSync(recovery.path, this.databasePath)
      this.db = openDatabase(this.databasePath)
      migrateDatabase(this.db)
      this.caches.facets.clear()
      this.caches.shenlunQuality = null
      throw new Error(
        `恢复失败，已自动回到操作前快照：${error instanceof Error ? error.message : '未知错误'}`
      )
    }
  }

  pruneBackups(retention: number): void {
    systemRepo.pruneBackups(this.backupDirectory, retention)
  }

  integrityCheck(): string {
    return systemRepo.integrityCheck(this.db)
  }

  databaseSize(): number {
    return systemRepo.databaseSize(this.databasePath)
  }

  resetLearningData(): void {
    systemRepo.resetLearningData(this.db)
  }
}
