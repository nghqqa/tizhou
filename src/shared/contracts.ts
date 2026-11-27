import type { ShenlunMaterialQualityLevel } from './shenlun'

export type Subject = 'xingce' | 'shenlun'
export type QuestionType = 'single' | 'multiple' | 'judge' | 'essay'
export type Difficulty = 1 | 2 | 3 | 4 | 5

export interface QuestionOption {
  key: string
  text: string
  /** 图形题选项图片（images/ 相对路径）；图片选项允许 text 为空 */
  image?: string
}

export interface QuestionPaperRef {
  paper: string
  order: number
}

export interface Question {
  id: string
  subject: Subject
  category: string
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answer: string[]
  explanation: string
  difficulty: Difficulty
  source: string
  year?: number
  region?: string
  paper?: string
  material?: string
  /** 组题标识：同一大题材料下的连续小题共享（如资料分析一组材料带 5 题） */
  groupId?: string
  /** 组内小题序号，从小到大连续排列 */
  groupOrder?: number
  contentVersion?: string
  tags: string[]
  filePath?: string
  fileMtimeMs?: number
  fileSize?: number
  contentHash: string
  /** 同一题目在多套真题卷中的复现记录（联考共用卷），按卷重组模考时使用 */
  papers?: QuestionPaperRef[]
}

export interface PaperSummary {
  paper: string
  count: number
  year?: number
}

export interface ShenlunPaperSummary {
  paper: string
  count: number
  year?: number
  region?: string
}

export interface PaperProgressItem {
  paper: string
  subject: Subject
  year?: number
  region?: string
  questionCount: number
  examCount: number
  hasActiveExam: boolean
  latestExamId?: string
  latestScore?: number
  bestScore?: number
  latestDurationMinutes?: number
  latestFinishedAt?: string
  practicedQuestionCount: number
}

export interface StudySnippet {
  id: string
  kind: 'norm' | 'quote'
  title: string
  content: string
  sourceDocId?: string
  tags: string[]
  createdAt: string
}

export interface KnowledgeDocument {
  id: string
  subject: Subject | 'common'
  kind: 'knowledge' | 'pattern' | 'method'
  title: string
  summary: string
  content: string
  tags: string[]
  filePath?: string
}

export interface VaultInfo {
  id: string
  name: string
  path: string
  connectedAt: string
  lastIndexedAt: string
  questionCount: number
  documentCount: number
  warnings: string[]
  isBuiltin: boolean
}

export interface VaultIndexResult {
  vault: VaultInfo
  added: number
  updated: number
  removed: number
  skipped: number
  /** 内容未变、直接复用库中记录而未重新解析的文件数（增量索引） */
  reused?: number
  warnings: string[]
}

export interface VaultSnapshotInfo {
  id: string
  vaultId: string
  createdAt: string
  questionCount: number
  documentCount: number
  size: number
}

export type KnowledgeBuildMode = 'auto' | 'questions' | 'documents' | 'convert-only' | 'direct'
export type KnowledgeBuildQuality = 'standard' | 'high'

export interface KnowledgeSourceFile {
  id: string
  relativePath: string
  extension: string
  size: number
  modifiedAt: string
  eligible: boolean
  reason?: string
}

export interface KnowledgeSourceScan {
  sourcePath: string
  scannedAt: string
  files: KnowledgeSourceFile[]
  eligibleCount: number
  eligibleSize: number
  skippedCount: number
  warnings: string[]
}

export type OcrAccelerator = 'cpu' | 'dml'

export interface KnowledgeEngineStatus {
  available: boolean
  installing: boolean
  version?: string
  pythonPath?: string
  ocrAvailable: boolean
  /** 文档结构解析组件（表格还原/图形保真，RapidDoc）是否就绪 */
  structuredParseAvailable: boolean
  /** OCR 推理后端：dml = DirectML GPU 加速（仅 Windows + 可用显卡时由用户显式启用） */
  ocrAccelerator?: OcrAccelerator
  /** 检测到的独立显卡名称（用于决定是否展示 GPU 加速安装入口） */
  gpuAdapterName?: string
  /** 转换组件 pip 安装源偏好：'auto'（探活优选）或镜像 id */
  pipMirrorId?: string
  message: string
  supportedExtensions: string[]
  installProgress?: { phase: string; percent: number }
}

export interface KnowledgeBuildOptions {
  mode: KnowledgeBuildMode
  quality: KnowledgeBuildQuality
  subject: Subject | 'common' | 'auto'
  tags: string[]
  instruction: string
  rightsConfirmed: boolean
  /** 忽略转换缓存：本批次全部重新转换（结果照常写回缓存），排查识别问题时使用 */
  ignoreConversionCache?: boolean
  /** 任务级 VLM 批量预精校（次路径）：仅对表格/数字异常页按页调用视觉模型，
   *  需工坊 VLM 总开关已开启；硬编码单批页数上限，未确认产物仍走发布门禁 */
  enableVlmProofread?: boolean
}

export type KnowledgeBuildFileState =
  | 'queued'
  | 'converting'
  | 'converted'
  | 'organizing'
  | 'ready'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export interface OcrQualityReport {
  totalPages: number
  textLayerPages: number
  ocrPages: number
  emptyPages: number
  ocrLineCount: number
  /** 文字识别置信度（逐页 OCR 平均字符置信度；结构解析无字符级置信度时缺省） */
  averageConfidence?: number
  lowConfidenceLines: number
  removedPageNumbers: number
  warnings: string[]
  /** 结构解析模式产出（表格还原 + 图片保真）；逐页 OCR 无此标记 */
  structured?: boolean
  /** 结构解析识别的表格区域数 */
  tableRegions?: number
  /** 结构解析保存的图片区域数 */
  figureRegions?: number
  /** 版面模型弃置的水印/页眉页脚区域数 */
  discardedRegions?: number
  /** 已剥离的页眉/水印文本出现次数 */
  removedNoiseLines?: number
}

export interface KnowledgeBuildFile {
  sourceId: string
  relativePath: string
  size: number
  state: KnowledgeBuildFileState
  message?: string
  /** 转换结果来自本地缓存（源文件与转换器均未变化），本次未实际执行 OCR/MarkItDown */
  fromCache?: boolean
  artifactCount: number
  chunkCount: number
  ocrQuality?: OcrQualityReport
}

export type KnowledgeArtifactStatus = 'pending' | 'approved' | 'rejected' | 'published'

export interface KnowledgeArtifactSummary {
  id: string
  sourceId: string
  sourcePath: string
  kind: 'question' | 'document'
  subject: Subject | 'common'
  title: string
  category: string
  confidence: number
  /** 产物来源：direct-import = 规则确定性切题（confidence 无测量意义）；model = AI 提炼自报置信度 */
  generatedBy?: 'direct-import' | 'model'
  status: KnowledgeArtifactStatus
  warnings: string[]
  preview: string
  /** 能力边界分类：非 text-supported 的产物默认禁止自动发布 */
  capability?: ImportCapability
  /** 人工已在原始页面上确认内容正确（解除发布限制） */
  humanConfirmed?: boolean
  /** 导入质量分层（产物形态，不代表 OCR 内容正确）：
   *  structured=可作答结构 · review-required=能力边界需人工核对 · preserved-source=仅保留原始资料 */
  importQualityTier?: ImportQualityTier
  /** 来源页证据：产物可追溯到的 PDF 页（仅供人工对照原页，不代表 OCR 内容正确） */
  sourceEvidence?: SourceEvidence
}

/** 来源证据：多来源引用（题本/共享材料/解析册/保留页分开记录，不混为一个页码）。
 *  status 表示证据资产可用性（图片是否存在/完整）；mapping 表示页码来源（exact/estimated）——两者语义独立。 */
export interface SourceEvidence {
  status: 'available' | 'partial' | 'unavailable'
  /** partial 时的原因（如证据页超出任务容量上限） */
  partialReason?: string
  references: SourceReference[]
}

export interface SourceReference {
  role: 'question' | 'material' | 'solution' | 'preserved-page'
  sourceId: string
  relativePath: string
  pages: SourceEvidencePage[]
}

export interface SourceEvidencePage {
  /** 统一 1-based 页码 */
  pageNumber: number
  /** exact 仅来自解析状态机直接消费的行/版面 region；事后文本匹配、题号顺序、邻近关系一律 estimated */
  mapping: 'exact' | 'estimated'
  /** 证据资产 ID：渲染层经 IPC 获取，不接触本地路径 */
  evidenceAssetId?: string
  /** [0,1] 归一化 bbox（x0,y0,x1,y1，x1≥x0、y1≥y0） */
  bbox?: [number, number, number, number]
  regionType?: string
}

/** 导入质量分层：只反映产物形态，不表示 OCR 识别准确率 */
export type ImportQualityTier = 'structured' | 'review-required' | 'preserved-source'

/** 导入能力边界：诚实标注每份资料能被自动结构化到什么程度 */
export type ImportCapability =
  | 'text-supported'
  | 'table-review'
  | 'image-only-review'
  | 'graphic-review'
  | 'unsupported-auto-structure'

export interface KnowledgeArtifactDetail extends KnowledgeArtifactSummary {
  markdown: string
  evidenceExcerpt: string
}

export interface KnowledgeBuildJob {
  id: string
  sourcePath: string
  createdAt: string
  updatedAt: string
  status: 'queued' | 'running' | 'review' | 'completed' | 'cancelling' | 'cancelled' | 'failed'
  options: KnowledgeBuildOptions
  files: KnowledgeBuildFile[]
  artifacts: KnowledgeArtifactSummary[]
  processedFiles: number
  totalFiles: number
  approvedArtifacts: number
  pendingArtifacts: number
  failedFiles: number
  currentFile?: string
  message?: string
  outputPath: string
}

/** 批量审核结果 */
export interface BatchReviewResult {
  job: KnowledgeBuildJob
  processed: number
  skipped: number
  failed: number
  errors: string[]
}

export interface QuestionFilter {
  subject?: Subject
  category?: string
  /** 多模块别名/组合筛选（如国省考配比抽题兼容「言语理解」与「言语理解与表达」） */
  categories?: string[]
  type?: QuestionType
  difficulty?: Difficulty
  year?: number
  region?: string
  paper?: string
  query?: string
  onlyWrong?: boolean
  onlyFavorite?: boolean
  onlyUnattempted?: boolean
  limit?: number
}

export interface QuestionSummary {
  id: string
  subject: Subject
  category: string
  type: QuestionType
  difficulty: Difficulty
  source: string
  year?: number
  region?: string
  paper?: string
  stemPreview: string
  materialQuality?: ShenlunMaterialQualityLevel
  materialIssues?: string[]
  hasReferenceAnswer?: boolean
}

export interface QuestionFacets {
  years: number[]
  regions: string[]
  regionCounts?: Array<{ region: string; count: number }>
  papers: string[]
}

export interface PracticeSelection {
  mode: 'random' | 'sequence' | 'adaptive' | 'review'
  filter?: QuestionFilter
  count: number
  feedbackMode?: 'immediate' | 'summary'
  /** 指定题号列表直达练习（用于模考错题重刷、全局检索直达单题） */
  questionIds?: string[]
}

export interface PracticeSession {
  id: string
  mode: PracticeSelection['mode']
  feedbackMode: 'immediate' | 'summary'
  createdAt: string
  updatedAt: string
  questionIds: string[]
  questionSnapshots: Record<string, Question>
  currentIndex: number
  uncertainIds: string[]
  status: 'active' | 'completed' | 'abandoned'
}

export interface AttemptInput {
  questionId: string
  answer: string[]
  durationSeconds: number
  mode: 'practice' | 'review' | 'exam' | 'ai'
  sessionId?: string
  wrongCause?: string
  reviewFeedback?: 'forgot' | 'hard' | 'normal' | 'easy'
}

export interface AttemptResult {
  attemptId: string
  correct: boolean
  expected: string[]
  explanation: string
  nextReviewAt?: string
  mastered: boolean
  intervalDays?: number
  /** 供提交看解析后二次记忆评级幂等重算使用的作答前基线 */
  reviewBaseline?: { streak: number; stage: number; wrongCount: number }
}

export interface ReviewItem {
  question: Question
  dueAt: string
  wrongCount: number
  correctStreak: number
  reviewStage?: number
  lastWrongCause?: string
}

export interface QuestionLibraryItem {
  question: Question
  wrongCount: number
  correctStreak: number
  lastWrongCause?: string
  lastAttemptAt?: string
  dueAt?: string
  favorite: boolean
  note: string
  noteUpdatedAt?: string
}

export interface ExamConfig {
  title: string
  subject: Subject
  durationMinutes: number
  questionCount: number
  filter?: QuestionFilter
  /** 分模块抽题配比（国省考仿真组卷与专项冲刺预设使用） */
  categoryQuotas?: Array<{ category: string; count: number }>
}

export interface ExamAnswer {
  questionId: string
  answer: string[]
  durationSeconds: number
}

export interface ExamSession {
  id: string
  title: string
  subject: Subject
  startedAt: string
  updatedAt: string
  finishedAt?: string
  durationMinutes: number
  questionIds: string[]
  questionSnapshots: Record<string, Question>
  answers: Record<string, ExamAnswer>
  /** 交卷时持久化保存的「不确定/蒙题」题号列表，供复盘页一键转入间隔复习 */
  uncertainIds?: string[]
  status: 'active' | 'finished' | 'abandoned'
  score?: number
  correctCount?: number
}

export interface ConstructedDraft {
  id: string
  promptId: string
  title: string
  content: string
  updatedAt: string
}

export interface ConstructedEvaluation {
  id: string
  promptId: string
  score: number
  dimensions: Array<{ name: string; score: number; comment: string }>
  summary: string
  suggestions: string[]
  createdAt: string
  provider: string
}

export interface ConstructedAttemptRecord {
  id: string
  promptId: string
  title: string
  content: string
  evaluation: ConstructedEvaluation
  createdAt: string
}

export type PlanItemType = 'read_knowledge' | 'official_practice' | 'official_review' | 'ai_variant'

/** 根据计划项类型推导默认跳转路由（route 字段优先） */
export function planItemRoute(item: LearningPlanItem): string {
  if (item.route) return item.route
  const catQuery =
    item.category && item.category !== '综合能力'
      ? `&category=${encodeURIComponent(item.category)}`
      : ''
  switch (item.type) {
    case 'read_knowledge':
      return item.category && /申论|公文|写作|概括|对策|贯彻/.test(item.category)
        ? '/thinking/shenlun'
        : '/thinking/xingce'
    case 'official_practice':
      return `/practice?mode=adaptive&count=${item.target || 10}${catQuery}`
    case 'official_review':
      return '/review'
    case 'ai_variant':
      return '/ai-training'
    default:
      return '/practice'
  }
}

/** 计划项执行按钮文案 */
export function planItemActionLabel(item: LearningPlanItem): string {
  switch (item.type) {
    case 'read_knowledge':
      return '去阅读'
    case 'official_practice':
      return '去训练'
    case 'official_review':
      return '去复习'
    case 'ai_variant':
      return '去变式'
    default:
      return '去执行'
  }
}

export interface LearningPlanItem {
  id: string
  day: number
  type: PlanItemType
  title: string
  category?: string
  target: number
  completed: number
  done: boolean
  /** 点击计划项时跳转的路由（按 type 自动推导，也可显式指定） */
  route?: string
}

export interface LearningPlan {
  id: string
  title: string
  createdAt: string
  startDate: string
  durationDays: number
  dailyMinutes: number
  status: 'preview' | 'active' | 'completed' | 'cancelled'
  focus: string[]
  items: LearningPlanItem[]
}

export interface DiagnosisResult {
  generatedAt: string
  totalAttempts: number
  accuracy: number
  averageDurationSeconds: number
  strengths: Array<{ category: string; accuracy: number; attempts: number }>
  weaknesses: Array<{ category: string; accuracy: number; attempts: number }>
  recommendations: string[]
}

export interface DashboardData {
  todayAttempts: number
  todayMinutes: number
  dailyTarget: number
  accuracy: number
  dueReviews: number
  wrongQuestions: number
  masteredQuestions: number
  totalQuestions: number
  studyStreak: number
  subjectMastery: Array<{ subject: Subject; accuracy: number; attempts: number }>
  activeExam?: ExamSession
  activePlan?: LearningPlan
  recentAttempts: Array<{
    id: string
    questionId: string
    questionTitle: string
    correct: boolean
    createdAt: string
  }>
  activity: Array<{ date: string; attempts: number; accuracy: number }>
}

export interface ConstructedAttemptSummary {
  count: number
  uniquePrompts: number
  average: number
  best: number
}

export interface ReportData {
  range: '7d' | '30d' | 'all'
  totalAttempts: number
  correctAttempts: number
  accuracy: number
  studyMinutes: number
  categoryStats: Array<{
    category: string
    attempts: number
    correct: number
    accuracy: number
    averageDurationSeconds: number
  }>
  dailyStats: Array<{ date: string; attempts: number; accuracy: number; minutes: number }>
  wrongCauses: Array<{ cause: string; count: number }>
  essaySummary?: ConstructedAttemptSummary
}

export type AiProvider =
  | 'deepseek'
  | 'moonshot'
  | 'minimax'
  | 'qwen'
  | 'zhipu'
  | 'doubao'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'

export type AiProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generate-content'
  | 'ollama-openai'

export interface AiProviderInfo {
  id: AiProvider
  name: string
  protocol: AiProtocol
  defaultBaseUrl: string
  defaultModel: string
  local: boolean
  apiKeyRequired: boolean
}

export interface AiConfigInput {
  provider: AiProvider
  protocol: AiProtocol
  baseUrl: string
  model: string
  apiKey?: string
  temperature: number
  maxTokens: number
}

export interface AiConfigView extends Omit<AiConfigInput, 'apiKey'> {
  hasApiKey: boolean
  verified: boolean
  lastCheckedAt?: string
  lastError?: string
}

/** 多模态消息图片载荷：仅 VLM 按页精校等显式开启的功能使用；纯文本调用不传即完全兼容 */
export interface AiImageInput {
  mimeType: 'image/jpeg' | 'image/png'
  /** data URL（data:image/jpeg;base64,...），主进程按协议适配为各服务格式 */
  dataUrl: string
}

export interface LearnerMemory {
  id: string
  category: string
  content: string
  evidence: string
  source: 'agent' | 'user'
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface AgentToolStep {
  id: string
  toolName: string
  label: string
  mode: 'read' | 'write'
  argsSummary: string
  status: 'running' | 'done' | 'error'
  resultSummary?: string
  durationMs?: number
}

export type AgentActionKind =
  'start_practice' | 'enqueue_review' | 'save_note' | 'save_memory' | 'apply_plan'

export interface AgentActionProposal {
  id: string
  kind: AgentActionKind
  title: string
  summary: string
  reason: string
  previewItems?: string[]
  payload: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'error'
  resultMessage?: string
  navigateTo?: string
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: AiImageInput[]
  toolSteps?: AgentToolStep[]
  proposals?: AgentActionProposal[]
}

export interface AiConversation {
  id: string
  title: string
  questionId?: string
  messages: AiMessage[]
  createdAt: string
  updatedAt: string
}

export interface QuestionUserMeta {
  favorite: boolean
  note: string
  wrongCause?: string
}

export interface QuestionLibraryExportParams {
  tab: 'wrong' | 'favorite' | 'notes'
  category?: string
  wrongCause?: string
  query?: string
  includeAnswers: boolean
  includeNotes: boolean
  format: 'markdown' | 'html' | 'pdf'
  /** 仅 PDF 导出使用：exam 为无答案/答案附后试卷版，annotated 为每题题解对照版 */
  pdfLayout?: 'exam' | 'annotated'
}

export interface AiAskInput {
  messages: AiMessage[]
  purpose: 'chat' | 'explain' | 'evaluate' | 'variant' | 'plan' | 'knowledge'
}

export interface AiAskResult {
  content: string
  provider: string
  model: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
}

export interface AiStreamEvent {
  requestId: string
  type: 'chunk' | 'reset' | 'done' | 'error' | 'aborted'
  delta?: string
  content?: string
  error?: string
}

export interface AgentRunInput {
  requestId: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  questionId?: string
}

export interface AgentRunResult {
  content: string
  toolSteps: AgentToolStep[]
  proposals: AgentActionProposal[]
  provider: string
  model: string
  aborted?: boolean
}

export interface AgentActionExecuteResult {
  ok: boolean
  message: string
  navigateTo?: string
  savedMemory?: LearnerMemory
}

export interface AgentStreamEvent {
  requestId: string
  type:
    'status' | 'tool_start' | 'tool_result' | 'proposal' | 'chunk' | 'done' | 'aborted' | 'error'
  text?: string
  step?: AgentToolStep
  proposal?: AgentActionProposal
  delta?: string
  content?: string
  toolSteps?: AgentToolStep[]
  proposals?: AgentActionProposal[]
  error?: string
}

export interface QuestionUpdateInput {
  id: string
  category: string
  difficulty: Difficulty
  material?: string
  stem: string
  options: QuestionOption[]
  answer: string[]
  explanation: string
  tags: string[]
}

/** VLM 精校模型来源：reuse-main 直接复用全局 AI 配置；custom 单独配置视觉模型 */
export type VlmModelMode = 'reuse-main' | 'custom'

export interface VlmConfigInput {
  /** 总开关：关闭时 100% 本地离线，绝不发送任何图片到外部服务 */
  enabled: boolean
  mode: VlmModelMode
  /** mode='custom' 时的视觉模型配置（复用 AiProvider/AiProtocol 枚举与 SSRF 校验） */
  provider?: AiProvider
  protocol?: AiProtocol
  baseUrl?: string
  model?: string
  /** 仅在用户填写时更新；留空保持已保存凭据不变 */
  apiKey?: string
}

export interface VlmConfigView {
  enabled: boolean
  mode: VlmModelMode
  provider?: AiProvider
  protocol?: AiProtocol
  baseUrl?: string
  model?: string
  /** 只暴露是否存在，绝不回传明文密钥 */
  hasApiKey: boolean
  verified: boolean
  lastCheckedAt?: string
  lastError?: string
  /** 复用主模型时展示当前全局模型名（提示用户主模型是否适合看图） */
  mainProvider?: AiProvider
  mainModel?: string
}

/** 单产物按页 VLM 精校结果：只含建议，不落盘；由用户对比采纳后经 updateMarkdown 持久化 */
export interface VlmProofreadSuggestion {
  jobId: string
  artifactId: string
  /** 主进程重组后的完整 Markdown：YAML frontmatter（id/answer/options[].image 等）原样保留 */
  correctedMarkdown: string
  /** VLM 报告的变更说明（人工可读） */
  changes: string[]
  /** 存疑项（看不清/无法核对处，对应正文中的 [模糊待人工确认] 标记） */
  uncertainItems: string[]
  summary: string
  pages: Array<{ sourceId: string; pageNumber: number }>
}

export interface AiTrainingRecord {
  id: string
  sourceQuestionId: string
  stem: string
  options: QuestionOption[]
  answer: string[]
  explanation: string
  userAnswer: string[]
  correct: boolean
  createdAt: string
}

export interface IntegrationConfig {
  obsidianVaultPath: string
  obsidianExecutable: string
}

export interface ObsidianBackupInfo {
  id: string
  createdAt: string
  vaultPath: string
  size: number
  reason: 'manual' | 'pre-restore' | 'safe-mode'
}

export interface RuntimeStatus {
  appVersion: string
  platform: string
  databasePath: string
  dataDirectory: string
  vault: VaultInfo
  obsidian: { detected: boolean; executable?: string; vaultReady: boolean }
  ai: AiConfigView
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  uiScale: number
  dailyTarget: number
  defaultPracticeCount: number
  defaultExamMinutes: number
  reduceMotion: boolean
  autoBackup: boolean
  backupRetention: number
  examGoalName?: string
  examGoalDate?: string
  defaultRegion?: string
}

export interface BootstrapData {
  dashboard: DashboardData
  settings: AppSettings
  vault: VaultInfo
  ai: AiConfigView
}

export interface BackupInfo {
  id: string
  path: string
  createdAt: string
  size: number
  reason: 'manual' | 'automatic' | 'pre-restore'
}

export interface DiagnosticCheck {
  id: string
  label: string
  status: 'ok' | 'warning' | 'error'
  detail: string
  action?: string
}

export interface AppDiagnostic {
  generatedAt: string
  checks: DiagnosticCheck[]
}

export interface ConversionCacheEntryStat {
  key: string
  sourceName: string
  converter: string
  bytes: number
  createdAt: string
  hasImages: boolean
}

export interface ConversionCacheStats {
  entries: ConversionCacheEntryStat[]
  totalBytes: number
}

export interface AppUpdateStatus {
  checking: boolean
  available: boolean
  downloading: boolean
  downloaded: boolean
  progress?: number
  version?: string
  releaseNotes?: string
  error?: string
  source?: 'cnb' | 'github'
  currentVersion: string
}

export interface WorkbenchMethodMap {
  bootstrap: { params?: undefined; result: BootstrapData }
  'dashboard.get': { params?: undefined; result: DashboardData }
  'vault.choose': { params?: undefined; result: string | undefined }
  'vault.connect': { params: { path: string }; result: VaultIndexResult }
  'vault.reindex': { params?: undefined; result: VaultIndexResult }
  'vault.list': { params?: undefined; result: VaultInfo[] }
  'vault.active': { params?: undefined; result: VaultInfo | undefined }
  'vault.switch': { params: { id: string }; result: VaultInfo }
  'vault.clearWarnings': { params?: undefined; result: VaultInfo | undefined }
  'vault.snapshots': { params: { vaultId: string }; result: VaultSnapshotInfo[] }
  'vault.rollback': { params: { snapshotId: string }; result: VaultIndexResult }
  'vault.search': { params: QuestionFilter; result: Question[] }
  'vault.listSummary': { params: QuestionFilter; result: QuestionSummary[] }
  'vault.question': { params: { id: string }; result: Question | undefined }
  'vault.normalizeRegions': { params?: undefined; result: { updated: number } }
  'vault.categories': {
    params?: { subject?: Subject }
    result: Array<{ name: string; count: number }>
  }
  'vault.facets': { params?: { subject?: Subject; region?: string }; result: QuestionFacets }
  'vault.asset': { params: { sourceFilePath: string; assetPath: string }; result: string }
  'knowledgeBuilder.source.choose': { params?: undefined; result: string | undefined }
  'knowledgeBuilder.source.scan': { params: { path: string }; result: KnowledgeSourceScan }
  'knowledgeBuilder.engine.status': { params?: undefined; result: KnowledgeEngineStatus }
  'knowledgeBuilder.engine.install': { params?: undefined; result: KnowledgeEngineStatus }
  'knowledgeBuilder.engine.gpu.install': { params?: undefined; result: KnowledgeEngineStatus }
  'knowledgeBuilder.engine.gpu.remove': { params?: undefined; result: KnowledgeEngineStatus }
  'knowledgeBuilder.engine.mirror.set': { params: { id: string }; result: KnowledgeEngineStatus }
  'knowledgeBuilder.job.start': {
    params: { sourcePath: string; fileIds: string[]; options: KnowledgeBuildOptions }
    result: KnowledgeBuildJob
  }
  'knowledgeBuilder.job.latest': { params?: undefined; result: KnowledgeBuildJob | undefined }
  'knowledgeBuilder.job.get': { params: { id: string }; result: KnowledgeBuildJob }
  'knowledgeBuilder.job.cancel': { params: { id: string }; result: KnowledgeBuildJob }
  'knowledgeBuilder.job.retry': {
    params: { id: string; sourceIds?: string[] }
    result: KnowledgeBuildJob
  }
  'knowledgeBuilder.evidence.get': { params: { jobId: string; assetId: string }; result: string }
  'knowledgeBuilder.cache.stats': { params?: undefined; result: ConversionCacheStats }
  'knowledgeBuilder.cache.clear': { params: { sourceName?: string }; result: { removed: number } }
  'knowledgeBuilder.job.revert': { params: { id: string }; result: { removed: number } }
  'knowledgeBuilder.artifact.get': {
    params: { jobId: string; artifactId: string }
    result: KnowledgeArtifactDetail
  }
  'knowledgeBuilder.artifact.updateMarkdown': {
    params: {
      jobId: string
      artifactId: string
      /** 完整 Markdown（frontmatter 必须与原产物一致，主进程校验 id 不被篡改） */
      markdown: string
      /** 保存来源：vlm = 采纳 VLM 精校结果（warnings 补充复核提示）；manual = 人工编辑 */
      origin?: 'vlm' | 'manual'
    }
    result: KnowledgeArtifactDetail
  }
  'knowledgeBuilder.artifact.vlmProofread': {
    params: { jobId: string; artifactId: string }
    result: VlmProofreadSuggestion
  }
  'knowledgeBuilder.artifact.review': {
    params: {
      jobId: string
      artifactId: string
      status: 'pending' | 'approved' | 'rejected'
      /** 人工确认「已查看原始页面并确认内容正确」，解除能力边界发布限制 */
      confirmHumanReview?: boolean
    }
    result: KnowledgeBuildJob
  }
  'knowledgeBuilder.artifacts.reviewMany': {
    params: {
      jobId: string
      artifactIds?: string[]
      status: 'approved' | 'rejected'
    }
    result: BatchReviewResult
  }
  'knowledgeBuilder.publish': { params: { jobId: string }; result: VaultIndexResult }
  'documents.list': {
    params: { subject?: Subject | 'common'; kind?: KnowledgeDocument['kind']; query?: string }
    result: KnowledgeDocument[]
  }
  'questions.get': { params: { id: string }; result: Question | undefined }
  'questions.userMeta': {
    params: { questionIds: string[] }
    result: Record<string, QuestionUserMeta>
  }
  'wrongQuestion.setCause': { params: { questionId: string; wrongCause: string }; result: boolean }
  'questions.library': {
    params: {
      tab: 'wrong' | 'favorite' | 'notes'
      category?: string
      wrongCause?: string
      query?: string
      minWrongCount?: number
      limit?: number
    }
    result: QuestionLibraryItem[]
  }
  'questions.library.export': { params: QuestionLibraryExportParams; result: string | undefined }
  'questions.update': { params: QuestionUpdateInput; result: Question }
  'practice.select': { params: PracticeSelection; result: Question[] }
  'practice.session.start': { params: PracticeSelection; result: PracticeSession }
  'practice.session.active': {
    params: { mode: 'practice' | 'review' }
    result: PracticeSession | undefined
  }
  'practice.session.results': {
    params: { id: string }
    result: Array<{ questionId: string; answer: string[]; correct: boolean }>
  }
  'practice.session.update': {
    params: {
      id: string
      currentIndex?: number
      uncertainIds?: string[]
      appendQuestionIds?: string[]
    }
    result: PracticeSession
  }
  'practice.session.complete': {
    params: { id: string; abandoned?: boolean }
    result: PracticeSession
  }
  'questions.similar': { params: { id: string; limit?: number }; result: Question[] }
  'attempt.submit': { params: AttemptInput; result: AttemptResult }
  'favorite.set': { params: { questionId: string; favorite: boolean }; result: void }
  'favorite.get': { params: { questionId: string }; result: boolean }
  'note.save': { params: { questionId: string; content: string }; result: void }
  'note.get': { params: { questionId: string }; result: string }
  'review.due': { params?: { limit?: number }; result: ReviewItem[] }
  'review.rate': {
    params: {
      questionId: string
      feedback: 'forgot' | 'hard' | 'normal' | 'easy'
      baselineStreak?: number
      baselineStage?: number
    }
    result: {
      nextReviewAt?: string
      mastered: boolean
      intervalDays?: number
      reviewStage: number
    }
  }
  'review.enqueue': {
    params: { questionIds: string[]; reason?: string }
    result: { added: number; skipped: number }
  }
  'exam.create': { params: ExamConfig; result: ExamSession }
  'exam.active': { params?: undefined; result: ExamSession | undefined }
  'exam.save': { params: { examId: string; answer: ExamAnswer }; result: ExamSession }
  'exam.finish': { params: { examId: string; uncertainIds?: string[] }; result: ExamSession }
  'exam.history': { params?: undefined; result: ExamSession[] }
  'exam.get': { params: { examId: string }; result: ExamSession | null }
  'exam.papers': { params?: undefined; result: PaperSummary[] }
  'exam.createPaper': { params: { paper: string }; result: ExamSession }
  'exam.shenlunPapers': { params?: undefined; result: ShenlunPaperSummary[] }
  'exam.createShenlunPaper': {
    params: { paper: string; durationMinutes?: number }
    result: ExamSession
  }
  'exam.paperMatrix': { params?: { subject?: Subject }; result: PaperProgressItem[] }
  'snippets.list': {
    params?: { kind?: 'norm' | 'quote'; query?: string }
    result: StudySnippet[]
  }
  'snippets.save': {
    params: {
      id?: string
      kind: 'norm' | 'quote'
      title: string
      content: string
      sourceDocId?: string
      tags?: string[]
    }
    result: StudySnippet
  }
  'snippets.delete': { params: { id: string }; result: boolean }
  'migration.export': { params: { targetPath: string }; result: { message: string } }
  'migration.import': {
    params: { sourcePath: string; vaultTargetPath: string }
    result: { restartRequired: true; message: string }
  }
  'folder.pick': { params: { title: string }; result: string | undefined }
  'draft.save': { params: Omit<ConstructedDraft, 'updatedAt'>; result: ConstructedDraft }
  'draft.get': { params: { id: string }; result: ConstructedDraft | undefined }
  'constructed.evaluate': {
    params: { promptId: string; title: string; content: string; requestId?: string }
    result: ConstructedEvaluation
  }
  'constructed.saveSelfCheck': {
    params: {
      promptId: string
      title: string
      content: string
      hitPoints: string[]
      totalPoints: number
      score: number
    }
    result: ConstructedAttemptRecord
  }
  'constructed.history': {
    params?: { promptId?: string; limit?: number; range?: ReportData['range'] }
    result: ConstructedAttemptRecord[]
  }
  'reports.get': { params: { range: ReportData['range'] }; result: ReportData }
  'reports.exportMarkdown': { params: { range: ReportData['range'] }; result: string | undefined }
  'reports.exportObsidian': { params: { range: ReportData['range'] }; result: string }
  'diagnosis.get': { params?: undefined; result: DiagnosisResult }
  'plan.preview': {
    params: { durationDays: number; dailyMinutes: number; focus: string[] }
    result: LearningPlan
  }
  'plan.apply': { params: { plan: LearningPlan }; result: LearningPlan }
  'plan.active': { params?: undefined; result: LearningPlan | undefined }
  'plan.item.complete': {
    params: { planId: string; itemId: string; completed: number }
    result: LearningPlan
  }
  'plan.recordRead': {
    params: { category?: string; minutes?: number }
    result: LearningPlan | undefined
  }
  'plan.cancel': { params: { planId: string }; result: void }
  'ai.config.get': { params?: undefined; result: AiConfigView }
  'ai.config.save': { params: AiConfigInput; result: AiConfigView }
  'ai.config.clearCredential': { params?: undefined; result: AiConfigView }
  'ai.vlmConfig.get': { params?: undefined; result: VlmConfigView }
  'ai.vlmConfig.save': { params: VlmConfigInput; result: VlmConfigView }
  'ai.vlmConfig.clearCredential': { params?: undefined; result: VlmConfigView }
  'ai.vlmConfig.test': { params?: undefined; result: VlmConfigView }
  'ai.providers': { params?: undefined; result: AiProviderInfo[] }
  'ai.models.discover': { params?: undefined; result: string[] }
  'ai.test': { params?: undefined; result: AiConfigView }
  'ai.ask': { params: AiAskInput; result: AiAskResult }
  'ai.askStream': {
    params: AiAskInput & { requestId: string }
    result: AiAskResult & { aborted?: boolean }
  }
  'ai.stream.cancel': { params: { requestId: string }; result: boolean }
  'ai.conversations.list': { params?: { limit?: number }; result: AiConversation[] }
  'ai.conversations.save': {
    params: { id?: string; title: string; questionId?: string; messages: AiMessage[] }
    result: AiConversation
  }
  'ai.conversations.delete': { params: { id: string }; result: boolean }
  'agent.run': { params: AgentRunInput; result: AgentRunResult }
  'agent.cancel': { params: { requestId: string }; result: boolean }
  'agent.action.execute': {
    params: { proposal: AgentActionProposal }
    result: AgentActionExecuteResult
  }
  'memory.list': { params?: { onlyEnabled?: boolean }; result: LearnerMemory[] }
  'memory.save': {
    params: {
      id?: string
      category: string
      content: string
      evidence?: string
      source?: 'agent' | 'user'
    }
    result: LearnerMemory
  }
  'memory.toggle': { params: { id: string; enabled: boolean }; result: LearnerMemory }
  'memory.delete': { params: { id: string }; result: boolean }
  'aiTraining.record': {
    params: Omit<AiTrainingRecord, 'id' | 'correct' | 'createdAt'>
    result: AiTrainingRecord
  }
  'aiTraining.history': { params?: undefined; result: AiTrainingRecord[] }
  'settings.get': { params?: undefined; result: AppSettings }
  'settings.save': { params: Partial<AppSettings>; result: AppSettings }
  'runtime.status': { params?: undefined; result: RuntimeStatus }
  'integration.get': { params?: undefined; result: IntegrationConfig }
  'integration.save': { params: Partial<IntegrationConfig>; result: IntegrationConfig }
  'integration.openObsidian': { params?: undefined; result: void }
  'obsidian.backups': { params?: undefined; result: ObsidianBackupInfo[] }
  'obsidian.backup': { params?: undefined; result: ObsidianBackupInfo }
  'obsidian.restore': { params: { id: string }; result: ObsidianBackupInfo }
  'obsidian.safeMode': { params?: undefined; result: ObsidianBackupInfo }
  'backup.create': { params?: undefined; result: BackupInfo }
  'backup.list': { params?: undefined; result: BackupInfo[] }
  'backup.restore': { params: { path: string }; result: BootstrapData }
  'diagnostics.run': { params?: undefined; result: AppDiagnostic }
  'diagnostics.export': { params?: undefined; result: string | undefined }
  'user.resetLearningData': { params: { confirmation: string }; result: DashboardData }
  'shell.openPath': { params: { path: string }; result: boolean }
  'app.update.status': { params?: undefined; result: AppUpdateStatus }
  'app.update.check': { params?: undefined; result: AppUpdateStatus }
  'app.update.download': { params?: undefined; result: AppUpdateStatus }
  'app.update.install': { params?: undefined; result: AppUpdateStatus }
  'window.fullscreen.toggle': { params?: undefined; result: boolean }
  'window.fullscreen.get': { params?: undefined; result: boolean }
}

export type WorkbenchMethod = keyof WorkbenchMethodMap

export type WorkbenchResult<M extends WorkbenchMethod> = WorkbenchMethodMap[M]['result']

export type WorkbenchRequest = {
  [M in WorkbenchMethod]: WorkbenchMethodMap[M]['params'] extends undefined
    ? { method: M; params?: undefined }
    : undefined extends WorkbenchMethodMap[M]['params']
      ? { method: M; params?: WorkbenchMethodMap[M]['params'] }
      : { method: M; params: WorkbenchMethodMap[M]['params'] }
}[WorkbenchMethod]

export interface WorkbenchAPI {
  invoke<T = unknown>(request: WorkbenchRequest): Promise<T>
  platform: string
  onSettingsUpdated?: (listener: (settings: AppSettings) => void) => () => void
  onAiStream?: (listener: (event: AiStreamEvent) => void) => () => void
  onAgentEvent?: (listener: (event: AgentStreamEvent) => void) => () => void
  onFullscreenChanged?: (listener: (fullscreen: boolean) => void) => () => void
}
