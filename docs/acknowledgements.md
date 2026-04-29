---
outline: false
---

<script setup>

const contributors = [
  ['Kui Li (underfin)', 'https://github.com/underfin'],
].sort((a, b) => a[0].localeCompare(b[0])); // 按姓名字母顺序排序

</script>

# 致谢

Rolldown 项目最初由 [Yinan Long](https://github.com/Brooooooklyn)（即 Brooooooklyn，[NAPI-RS](https://napi.rs/) 的作者）创建。如今，Rolldown 由 [Evan You](https://github.com/yyx990803)（[Vite](https://vitejs.dev/) 的创建者）领导，并由全职 [团队](./team.md) 以及充满热情的开源 [贡献者](https://github.com/rolldown/rolldown/graphs/contributors) 共同推动。

## 过往贡献者

我们想表彰几位曾是团队成员，或对项目、文档及其生态系统做出重大贡献的人（按字母顺序列出）：

<ul>
<template v-for="contributor in contributors" :key="contributor[0]">
  <li>
    <a :href="contributor[1]" target="_blank">
      {{ contributor[0] }}
    </a>
  </li>
</template>
</ul>

此列表并不完整。

## 额外致谢

此外，我们还要感谢：

- [Charlike Mike Reagent](https://github.com/tunnckoCore) 允许我们在 npm 上使用 `rolldown` 包名
