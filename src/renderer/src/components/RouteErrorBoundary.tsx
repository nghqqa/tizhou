// 页面级错误边界：单个页面渲染崩溃不白屏整个应用。
// 保留侧栏导航；错误详情只输出到本地控制台，不上传用户数据；
// 「重新加载当前页面」复位边界（配合 key=pathname，路由切换自动复位）。
import { Component, type ReactNode } from 'react'
import { MessageBar, MessageBarActions, MessageBarBody, Button } from '@fluentui/react-components'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    // 仅本地控制台记录，便于用户主动反馈；不做任何网络上报
    console.error('[页面错误]', error)
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="global-message">
          <MessageBar intent="error">
            <MessageBarBody>页面加载失败。此页面的数据不受影响。</MessageBarBody>
            <MessageBarActions>
              <Button onClick={() => this.setState({ failed: false })}>重新加载当前页面</Button>
            </MessageBarActions>
          </MessageBar>
        </div>
      )
    }
    return this.props.children
  }
}
