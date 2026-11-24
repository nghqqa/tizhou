import { dialog } from 'electron'
import type { IpcContext, IpcHandlerMap } from './types'

type BuilderHandlerKeys =
  | 'knowledgeBuilder.source.choose'
  | 'knowledgeBuilder.source.scan'
  | 'knowledgeBuilder.engine.status'
  | 'knowledgeBuilder.engine.install'
  | 'knowledgeBuilder.engine.gpu.install'
  | 'knowledgeBuilder.engine.gpu.remove'
  | 'knowledgeBuilder.engine.mirror.set'
  | 'knowledgeBuilder.job.start'
  | 'knowledgeBuilder.job.latest'
  | 'knowledgeBuilder.job.get'
  | 'knowledgeBuilder.job.cancel'
  | 'knowledgeBuilder.job.retry'
  | 'knowledgeBuilder.job.revert'
  | 'knowledgeBuilder.artifact.get'
  | 'knowledgeBuilder.artifact.updateMarkdown'
  | 'knowledgeBuilder.artifact.vlmProofread'
  | 'knowledgeBuilder.artifact.review'
  | 'knowledgeBuilder.artifacts.reviewMany'
  | 'knowledgeBuilder.evidence.get'
  | 'knowledgeBuilder.cache.stats'
  | 'knowledgeBuilder.cache.clear'
  | 'knowledgeBuilder.publish'

export function createBuilderHandlers(ctx: IpcContext): Pick<IpcHandlerMap, BuilderHandlerKeys> {
  const { knowledgeBuilder } = ctx
  return {
    'knowledgeBuilder.source.choose': async () => {
      const selected = await dialog.showOpenDialog(ctx.getMainWindow()!, {
        title: '选择未整理的知识库原料目录',
        properties: ['openDirectory']
      })
      return selected.canceled ? undefined : selected.filePaths[0]
    },
    'knowledgeBuilder.source.scan': (params) => knowledgeBuilder.scan(params.path),
    'knowledgeBuilder.engine.status': () => knowledgeBuilder.engineStatus(),
    'knowledgeBuilder.engine.install': () => knowledgeBuilder.installEngine(),
    'knowledgeBuilder.engine.gpu.install': () => knowledgeBuilder.installGpuAccelerator(),
    'knowledgeBuilder.engine.gpu.remove': () => knowledgeBuilder.removeGpuAccelerator(),
    'knowledgeBuilder.engine.mirror.set': async (params) => {
      await knowledgeBuilder.setPipMirror(params.id)
      return knowledgeBuilder.engineStatus()
    },
    'knowledgeBuilder.job.start': (params) => knowledgeBuilder.startJob(params),
    'knowledgeBuilder.job.latest': () => knowledgeBuilder.latestJob(),
    'knowledgeBuilder.job.get': (params) => knowledgeBuilder.getJob(params.id),
    'knowledgeBuilder.job.cancel': (params) => knowledgeBuilder.cancelJob(params.id),
    'knowledgeBuilder.job.retry': (params) =>
      knowledgeBuilder.retryJob(params.id, params.sourceIds),
    'knowledgeBuilder.job.revert': (params) => knowledgeBuilder.revertImport(params.id),
    'knowledgeBuilder.artifact.get': (params) =>
      knowledgeBuilder.getArtifact(params.jobId, params.artifactId),
    'knowledgeBuilder.artifact.updateMarkdown': (params) =>
      knowledgeBuilder.updateArtifactMarkdown(
        params.jobId,
        params.artifactId,
        params.markdown,
        params.origin
      ),
    'knowledgeBuilder.artifact.vlmProofread': (params) =>
      knowledgeBuilder.vlmProofreadArtifact(params.jobId, params.artifactId),
    'knowledgeBuilder.artifact.review': (params) =>
      knowledgeBuilder.reviewArtifact(
        params.jobId,
        params.artifactId,
        params.status,
        params.confirmHumanReview
      ),
    'knowledgeBuilder.artifacts.reviewMany': (params) =>
      knowledgeBuilder.reviewArtifacts(params.jobId, params.artifactIds, params.status),
    'knowledgeBuilder.evidence.get': (params) =>
      knowledgeBuilder.readEvidenceAsset(params.jobId, params.assetId),
    'knowledgeBuilder.cache.stats': () => knowledgeBuilder.cacheStats(),
    'knowledgeBuilder.cache.clear': (params) =>
      knowledgeBuilder.clearConversionCache(params.sourceName),
    'knowledgeBuilder.publish': (params) => knowledgeBuilder.publish(params.jobId)
  }
}
