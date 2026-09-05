// 客观题答案保存控制器：串行化 + 同题去重 + 失败保留 + drain/destroy
import { describe, expect, it, vi } from 'vitest'
import { ExamAnswerSaveController } from '../src/renderer/src/services/exam-essay-save'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeController(
  saveImpl: (req: { questionId: string; answer: string[] }) => Promise<void>
) {
  const onSettled = vi.fn()
  const saveCalls: Array<{ questionId: string; answer: string[] }> = []
  const saveFn = vi.fn(
    async (request: { examId: string; questionId: string; answer: string[] }) => {
      saveCalls.push({ questionId: request.questionId, answer: request.answer })
      await saveImpl(request)
    }
  )
  const controller = new ExamAnswerSaveController(saveFn as never, onSettled)
  return { controller, onSettled, saveCalls, saveFn }
}

describe('ExamAnswerSaveController', () => {
  it('快速连续选择 A→B→C：只发送最新答案 C', async () => {
    const { controller, saveCalls } = makeController(async () => {})
    controller.save({ examId: 'e', questionId: 'q1', answer: ['A'] })
    controller.save({ examId: 'e', questionId: 'q1', answer: ['B'] })
    controller.save({ examId: 'e', questionId: 'q1', answer: ['C'] })
    await controller.drain()
    expect(saveCalls).toEqual([{ questionId: 'q1', answer: ['C'] }])
  })

  it('多题保存互不干扰，按 questionId 区分', async () => {
    const { controller, saveCalls } = makeController(async () => {})
    controller.save({ examId: 'e', questionId: 'q1', answer: ['A'] })
    controller.save({ examId: 'e', questionId: 'q2', answer: ['B'] })
    await controller.drain()
    expect(saveCalls.map((call) => call.questionId).sort()).toEqual(['q1', 'q2'])
    expect(saveCalls.find((call) => call.questionId === 'q2')?.answer).toEqual(['B'])
  })

  it('切题后旧题的保存不会写入新题的 questionId', async () => {
    const { controller, saveCalls } = makeController(async () => {})
    controller.save({ examId: 'e', questionId: 'q1', answer: ['A'] })
    await controller.drain()
    controller.save({ examId: 'e', questionId: 'q2', answer: ['B'] })
    await controller.drain()
    expect(saveCalls.every((call) => call.questionId !== 'q1' || call.answer[0] === 'A')).toBe(true)
  })

  it('保存失败保留待重试，retryAll 只重试失败项且成功后清空', async () => {
    let shouldFail = true
    const { controller, saveCalls, saveFn } = makeController(async () => {
      if (shouldFail) throw new Error('网络错误')
    })
    controller.save({ examId: 'e', questionId: 'q1', answer: ['A'] })
    const failed = await controller.drain()
    expect(failed).toEqual(['q1'])
    expect(controller.failedQuestionIds()).toEqual(['q1'])

    shouldFail = false
    controller.retryAll()
    await controller.drain()
    expect(controller.failedQuestionIds()).toHaveLength(0)
    // 重试只针对失败的那一次请求（共 2 次调用：1 失败 + 1 重试成功）
    expect(saveFn).toHaveBeenCalledTimes(2)
    expect(saveCalls[1]).toEqual({ questionId: 'q1', answer: ['A'] })
  })

  it('pump 失败停摆后，新入队的答案仍会被保存', async () => {
    let shouldFail = true
    const { controller, saveCalls } = makeController(async () => {
      if (shouldFail) throw new Error('网络错误')
    })
    controller.save({ examId: 'e', questionId: 'q1', answer: ['A'] })
    await controller.drain()
    shouldFail = false
    // 失败停摆后用户切换到另一题作答
    controller.save({ examId: 'e', questionId: 'q2', answer: ['B'] })
    await controller.drain()
    expect(saveCalls.some((call) => call.questionId === 'q2')).toBe(true)
  })

  it('交卷 drain 会等待挂起保存全部完成', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { controller, saveCalls } = makeController(async () => {
      await gate
    })
    controller.save({ examId: 'e', questionId: 'q1', answer: ['A'] })
    const draining = controller.drain()
    // drain 尚未完成（保存被 gate 拦住）
    let drained = false
    void draining.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await draining
    expect(drained).toBe(true)
    expect(saveCalls).toHaveLength(1)
  })

  it('destroy 会先把挂起保存完成', async () => {
    const { controller, saveCalls } = makeController(async () => {})
    controller.save({ examId: 'e', questionId: 'q1', answer: ['A'] })
    await controller.destroy()
    expect(saveCalls).toHaveLength(1)
    // 销毁后不再接受新保存
    controller.save({ examId: 'e', questionId: 'q2', answer: ['B'] })
    expect(saveCalls).toHaveLength(1)
  })

  it('空答案与多选答案原样传递', async () => {
    const { controller, saveCalls } = makeController(async () => {})
    controller.save({ examId: 'e', questionId: 'q1', answer: [] })
    controller.save({ examId: 'e', questionId: 'q2', answer: ['A', 'C'] })
    await controller.drain()
    expect(saveCalls.find((call) => call.questionId === 'q1')?.answer).toEqual([])
    expect(saveCalls.find((call) => call.questionId === 'q2')?.answer).toEqual(['A', 'C'])
  })
})
