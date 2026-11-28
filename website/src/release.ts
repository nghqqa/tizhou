// 官网发布配置（单一来源）：版本、下载通道、自建直链开关、站点 URL、页脚信息位。
// 修改版本号时只改这里；站点域名更换时同步改 url 字段，sitemap 与 OG 标签在构建时自动跟随。
export const release = {
  version: '1.0.56',
  platform: 'Windows 10/11 64 位',
  license: 'MIT 开源',
  siteUrl: 'https://tizhou.nghqqa.cn',
  asset: {
    name: 'tizhou-setup-1.0.56.exe',
    sizeHint: '约 97 MB',
    checksumFile: 'SHA256SUMS.txt',
    checksumCommand: 'certutil -hashfile tizhou-setup-1.0.56.exe SHA256'
  },
  // 主按钮直连匿名下载（CNB Releases 附件，已验证匿名 200）；
  // releasePages 作为「全量文件与校验文件」入口，安装包流量不经过自有 Web 服务器
  directDownload: {
    url: 'https://cnb.cool/nghqqa/tizhou/-/releases/download/v1.0.56/tizhou-setup-1.0.56.exe'
  },
  checksumUrls: {
    cnb: 'https://cnb.cool/nghqqa/tizhou/-/releases/download/v1.0.56/SHA256SUMS.txt',
    github: 'https://github.com/nghqqa/tizhou/releases/download/v1.0.56/SHA256SUMS.txt'
  },
  releasePages: {
    cnb: 'https://cnb.cool/nghqqa/tizhou/-/releases',
    github: 'https://github.com/nghqqa/tizhou/releases/latest'
  },
  channels: [
    {
      id: 'github',
      label: 'GitHub Releases',
      provider: 'GitHub',
      url: 'https://github.com/nghqqa/tizhou/releases/latest',
      primary: false,
      note: '国际网络适用'
    }
  ],
  selfHosted: {
    enabled: false,
    url: '/downloads/tizhou-setup-1.0.56.exe',
    note: '服务器直链（带宽充足后改 enabled 为 true 即可启用）'
  },
  // 同域名 302 跳转入口：生产环境由 Nginx 重定向到上方直链，零 Cookie / 零前端埋点，
  // 通过服务器专属访问日志统计点击量与下载转化率（deploy.sh 发版时自动同步目标地址）
  redirects: {
    enabled: true,
    downloadCnb: '/go/download-cnb',
    downloadGithub: '/go/download-github',
    releasesCnb: '/go/releases-cnb',
    checksumCnb: '/go/checksum-cnb',
    checksumGithub: '/go/checksum-github'
  },
  icp: ''
}
