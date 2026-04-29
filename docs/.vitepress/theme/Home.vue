<script setup>
import Hero from './Hero.vue';
// import TrustedBy from '@components/oss/TrustedBy.vue'
import HeadingSection from '@voidzero-dev/vitepress-theme/src/components/oss/HeadingSection.vue';
import RolldownFeatureGrid from './FeatureGrid.vue';
import Sponsors from '@voidzero-dev/vitepress-theme/src/components/oss/Sponsors.vue';
import Spacer from '@voidzero-dev/vitepress-theme/src/components/shared/Spacer.vue';
import Footer from '@voidzero-dev/vitepress-theme/src/components/oss/Footer.vue';
</script>

<template>
  <Hero />
  <!-- 'framer' requires public/trusted-by/framer.svg -->
  <!-- <TrustedBy :logos="['framer', 'angular']" /> -->
  <HeadingSection heading="性能 + 功能 + 生态" />
  <RolldownFeatureGrid />
  <Sponsors
    description="Rolldown 是免费且开源的项目，这离不开全职团队和热情的开源贡献者。"
    sponsorLinkText="参与贡献"
    sponsorLink="/contribution-guide"
  />
  <Spacer />
  <Footer
    heading="使用 Rolldown 优化你的 JavaScript 代码"
    subheading="为什么我们仍然需要打包器？"
    button-text="了解更多"
    button-link="/in-depth/why-bundlers"
  />
</template>
