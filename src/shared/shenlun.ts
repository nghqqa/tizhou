export type ShenlunQuestionType = '单一题' | '综合题' | '公文题' | '作文题'

export const SHENLUN_QUESTION_TYPES: readonly ShenlunQuestionType[] = [
  '单一题',
  '综合题',
  '公文题',
  '作文题'
]

const ESSAY_ARTICLE_RE =
  /写一篇文章|写一篇.{0,4}(?:文章|论文)|策论文|自拟题目|自选角度|议论文|800\s*[—–~-]\s*1\d{3}\s*字|不少于\s*(?:800|1000)\s*字|1000\s*字左右/

const OFFICIAL_DOC_RE =
  /倡议书|发言稿|讲话稿|演讲稿|公开信|感谢信|回信|汇报|简报|编者按|短评|新闻稿|调研报告|考察报告|情况说明|通知|通告|工作方案|导语|推介|讲解词|致辞|提纲|撰写|起草一[份篇]|拟写一[份篇]|写一[份篇].{0,8}(?:稿|信|报告|书|材料|方案)/

const ANALYSIS_RE =
  /谈谈.{0,12}(?:理解|认识|看法|启示|体会|感悟)|如何理解|怎样理解|谈谈你对|评析|评价|辨析|启示/

/** 将各渠道导入的申论题目统一归类为「单一题 / 综合题 / 公文题 / 作文题」 */
export function classifyShenlunType(category?: string, stem?: string): ShenlunQuestionType {
  const cat = (category ?? '').trim()
  if (cat) {
    if (/大作文|作文|申发论述|文章写作/.test(cat)) return '作文题'
    if (/贯彻执行|应用文|公文/.test(cat)) return '公文题'
    if (/综合分析|综合题/.test(cat)) return '综合题'
    if (/归纳概括|提出对策|单一题|概括|对策/.test(cat)) return '单一题'
  }

  const text = (stem ?? '').replace(/\s+/g, '')
  if (text) {
    if (ESSAY_ARTICLE_RE.test(text)) return '作文题'
    if (OFFICIAL_DOC_RE.test(text)) return '公文题'
    if (ANALYSIS_RE.test(text)) return '综合题'
  }
  return '单一题'
}
