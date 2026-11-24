import type { ExamSession } from '@shared/contracts'
import { removeLocalStorageByPrefix } from '../../hooks/useLocalStorageState'

export const EXAM_UNCERTAIN_PREFIX = 'tizhou:exam-uncertain:'

/** 清理已结束或弃考模考遗留的本地待查标记，仅保留当前进行中的场次 */
export function pruneStaleExamUncertainKeys(activeExamId?: string): void {
  const keepKey = activeExamId ? `${EXAM_UNCERTAIN_PREFIX}${activeExamId}` : ''
  removeLocalStorageByPrefix(EXAM_UNCERTAIN_PREFIX, keepKey)
}

export function remainingSeconds(exam: ExamSession): number {
  const deadline = new Date(exam.startedAt).getTime() + exam.durationMinutes * 60_000
  return Math.max(0, Math.floor((deadline - Date.now()) / 1000))
}
