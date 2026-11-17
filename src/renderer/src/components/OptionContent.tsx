import type { QuestionOption } from '@shared/contracts'
import { MarkdownContent } from './MarkdownContent'

/** 选项内容：纯文字选项走 Markdown 渲染；图片选项（图形推理）复用 MarkdownContent 的
 *  vault.asset 取图机制（与题干图片同一加载管线，禁止手写 file:// 路径），
 *  图文混合选项先文字后图片。图片选项在按钮网格内限制宽度，选中/对错高亮由外层
 *  .option-button 承担，深浅主题变量自动跟随。 */
export function OptionContent(props: {
  option: QuestionOption
  sourceFilePath?: string
}): React.JSX.Element {
  const { option, sourceFilePath } = props
  if (option.image) {
    return (
      <span className="option-content">
        {option.text ? (
          <MarkdownContent content={option.text} sourceFilePath={sourceFilePath} />
        ) : null}
        <MarkdownContent
          className="option-image"
          content={`![选项 ${option.key}](${option.image})`}
          sourceFilePath={sourceFilePath}
        />
      </span>
    )
  }
  return <MarkdownContent content={option.text} sourceFilePath={sourceFilePath} />
}
