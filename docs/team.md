---
outline: false
---

<script setup>
import { VPTeamMembers } from '@voidzero-dev/vitepress-theme'

const members = [
  {
    avatar: 'https://www.github.com/yyx990803.png',
    name: 'Evan You',
    links: [
      { icon: 'github', link: 'https://github.com/yyx990803' },
      { icon: 'x', link: 'https://x.com/youyuxi' }
    ]
  },
  {
    avatar: 'https://www.github.com/Brooooooklyn.png',
    name: 'Yinan Long (Brooooooklyn)',
    links: [
      { icon: 'github', link: 'https://github.com/Brooooooklyn' },
      { icon: 'x', link: 'https://x.com/Brooooook_lyn' }
    ]
  },
  {
    avatar: 'https://www.github.com/hyf0.png',
    name: 'Yunfei He (hyf0)',
    links: [
      { icon: 'github', link: 'https://github.com/hyf0' },
      { icon: 'x', link: 'https://x.com/_hyf0' }
    ]
  },
  {
    avatar: 'https://www.github.com/iwanabethatguy.png',
    name: 'Xiangjun He (iwanabethatguy)',
    links: [
      { icon: 'github', link: 'https://github.com/iwanabethatguy' }
    ]
  },
  {
    avatar: 'https://www.github.com/boshen.png',
    name: 'Boshen',
    links: [
      { icon: 'github', link: 'https://github.com/boshen' },
      { icon: 'x', link: 'https://x.com/boshen_c' },
      { icon: 'bluesky', link: 'https://bsky.app/profile/boshen.github.io' }
    ]
  },
  {
    name: 'shulaoda',
    avatar: 'https://www.github.com/shulaoda.png',
    links: [
      { icon: 'github', link: 'https://github.com/shulaoda' },
      { icon: 'x', link: 'https://x.com/dalaoshv' }
    ]
  },
  {
    name: 'Kevin Deng (sxzz)',
    avatar: 'https://www.github.com/sxzz.png',
    links: [
      { icon: 'github', link: 'https://github.com/sxzz' },
      { icon: 'x', link: 'https://x.com/sanxiaozhizi' },
      { icon: 'bluesky', link: 'https://bsky.app/profile/sxzz.dev' }
    ]
  },
  {
    name: '翠 (sapphi-red)',
    avatar: 'https://www.github.com/sapphi-red.png',
    links: [
      { icon: 'github', link: 'https://github.com/sapphi-red' },
      { icon: 'x', link: 'https://x.com/sapphi_red' },
      { icon: 'bluesky', link: 'https://bsky.app/profile/sapphi.red' }
    ]
  },
  {
    name: 'Shuyuan Wang (h-a-n-a)',
    avatar: 'https://www.github.com/h-a-n-a.png',
    links: [
      { icon: 'github', link: 'https://github.com/h-a-n-a' },
      { icon: 'x', link: 'https://x.com/_h_ana___' }
    ]
  },
  {
    name: 'Alexander Lichter',
    avatar: 'https://www.github.com/TheAlexLichter.png',
    links: [
      { icon: 'github', link: 'https://github.com/TheAlexLichter' },
      { icon: 'x', link: 'https://x.com/TheAlexLichter' },
      { icon: 'bluesky', link: 'https://bsky.app/profile/thealexlichter.com' }
    ]
  }
]
</script>

# 团队

团队成员全职投入 Rolldown 项目，负责其开发、维护和社区参与。

<VPTeamMembers size="small" :members="members" />

## 过往贡献者

你可以在 [致谢](./acknowledgements.md) 页面找到过往的团队成员以及其他在这些年里为 Rolldown 做出重要贡献的人。

## 加入我们！

Rolldown 仍处于早期阶段。我们还有很多工作要做，如果没有社区贡献者的帮助，我们将无法完成这一切。我们也正在积极寻找更多愿意长期投入、使用 Rust 改进 JavaScript 工具链的团队成员。

### 有用链接

- [GitHub](https://github.com/rolldown/rolldown)
- [贡献指南](/contribution-guide/)
- [Discord 聊天](https://chat.rolldown.rs)
