import type { AiConfigView, Question } from '@shared/contracts'
import { taskDataEnvelope } from '@shared/prompts'

export function canUseModel(config: AiConfigView): boolean {
  return config.hasApiKey || config.provider === 'ollama' || config.provider === 'lmstudio'
}

export function buildQuestionContextPrompt(question: Question): string {
  return taskDataEnvelope('关联追问原题背景', {
    category: question.category,
    subject: question.subject,
    type: question.type,
    material: question.material ?? '',
    stem: question.stem,
    options: question.options.map((opt) => `${opt.key}. ${opt.text}`),
    referenceAnswer: question.answer,
    referenceExplanation: question.explanation
  })
}
