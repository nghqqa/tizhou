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
  colorNeutralBackground1: '#F5F1E8',
  colorNeutralBackground2: '#FBF9F4',
  colorNeutralBackground3: '#F0ECE2',
  colorNeutralBackground4: '#EAE5D9',
  colorNeutralBackground5: '#E3DED2',
  colorNeutralBackground6: '#DBD5C8',
  colorNeutralStroke1: '#D5CFC2',
  colorNeutralStroke2: '#E2DDD2',
  colorNeutralForeground1: '#282520',
  colorNeutralForeground2: '#4A443C',
  colorNeutralForeground3: '#746E64'
}

// 深色主题：墨黑 · 灯下案牍（四层表面 + 可读性优先）
export const darkTheme: Theme = {
  ...createDarkTheme(brand),
  // 四层表面层级
  colorNeutralBackground1: '#151412',   // 应用背景（最暗，侧栏/外框）
  colorNeutralBackground2: '#1B1917',   // 工作区背景
  colorNeutralBackground3: '#24211E',   // 普通内容区域
  colorNeutralBackground4: '#2B2521',   // 浮起/重点区域
  colorNeutralBackground5: '#332C27',
  colorNeutralBackground6: '#3C342E',
  // 边框
  colorNeutralStroke1: 'rgba(235, 223, 208, 0.14)',
  colorNeutralStroke2: 'rgba(235, 223, 208, 0.08)',
  // 文字四层
  colorNeutralForeground1: '#F0EAE1',   // 主标题
  colorNeutralForeground2: '#D1C8BC',   // 正文
  colorNeutralForeground3: '#A49A8E',   // 次级
  colorNeutralForegroundDisabled: '#766F67'
}
