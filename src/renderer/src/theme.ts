import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme
} from '@fluentui/react-components'

// 朱砂红色阶：新中式案牍主强调色
const brand: BrandVariants = {
  10: '#FBEAE6',
  20: '#F5D5CE',
  30: '#EBBAB0',
  40: '#DE9C8F',
  50: '#CE7B6C',
  60: '#B84432',
  70: '#A03A2A',
  80: '#87352B',
  90: '#6E2A22',
  100: '#55201A',
  110: '#3C1713',
  120: '#2A100D',
  130: '#1D0B09',
  140: '#140706',
  150: '#0D0403',
  160: '#080202'
}

// 浅色主题：宣纸白 · 案牍秩序
export const lightTheme: Theme = {
  ...createLightTheme(brand),
  colorNeutralBackground1: '#F5F1E8',    // 宣纸白·环境底色
  colorNeutralBackground2: '#FBF9F4',   // 绢白·内容卡片
  colorNeutralBackground3: '#F0ECE2',   // 淡茶·次级面板
  colorNeutralBackground4: '#EAE5D9',   // 旧纸·三级面板
  colorNeutralBackground5: '#E3DED2',
  colorNeutralBackground6: '#DBD5C8',
  colorNeutralStroke1: '#D5CFC2',       // 淡墨边框
  colorNeutralStroke2: '#E2DDD2',       // 更淡的边框
  colorNeutralForeground1: '#282520',   // 墨黑·主文字
  colorNeutralForeground2: '#4A443C',   // 深墨·次级文字
  colorNeutralForeground3: '#746E64'    // 烟灰·辅助文字
}

// 深色主题：墨黑 · 灯下案牍
export const darkTheme: Theme = {
  ...createDarkTheme(brand),
  colorNeutralBackground1: '#1C1A17',   // 墨黑·环境
  colorNeutralBackground2: '#24211D',   // 炭灰·内容
  colorNeutralBackground3: '#2C2823',   // 深炭·次级面板
  colorNeutralBackground4: '#353029',
  colorNeutralBackground5: '#3E3830',
  colorNeutralBackground6: '#484139',
  colorNeutralStroke1: '#3E3830',       // 暗淡墨
  colorNeutralStroke2: '#322E27',
  colorNeutralForeground1: '#EDE9E0',   // 米白·主文字
  colorNeutralForeground2: '#C8C2B6',   // 浅灰·次级
  colorNeutralForeground3: '#928B7E'    // 烟灰·辅助
}
