<script setup>
import RiveAnimation from '@voidzero-dev/vitepress-theme/src/components/shared/RiveAnimation.vue';
import vitePoweredAnimation from '@voidzero-dev/vitepress-theme/src/assets/rolldown/animations/640_x_300_design_for_vite.riv';
import PerformanceBar from '@voidzero-dev/vitepress-theme/src/components/shared/PerformanceBar.vue';
import performanceBarBg from '@voidzero-dev/vitepress-theme/src/assets/rolldown/rolldown-rollup-background.jpg';

const performanceData = [
  {
    name: 'Rolldown',
    percentage: 4.01,
    time: '1.61s',
    isPrimary: true,
  },
  {
    name: 'esbuild',
    percentage: 4.24,
    time: '1.70s',
  },
  {
    name: 'rspack',
    percentage: 10.15,
    time: '4.07s',
  },
  {
    name: 'Rollup + esbuild',
    percentage: 100,
    time: '40.10s',
  },
];
</script>

<template>
  <section
    class="wrapper wrapper--ticks border-t grid lg:grid-cols-2 divide-x divide-y divide-nickel"
  >
    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-balance sm:text-pretty text-white">Rust 的速度</h5>
        <p class="sm:max-w-120 text-pretty">Rolldown 可以轻松处理数以万计的模块</p>
      </div>
      <div class="p-5 sm:p-15 flex flex-col gap-10">
        <div class="flex flex-col gap-4">
          <PerformanceBar
            v-for="item in performanceData"
            :key="item.name"
            :data="item"
            :background-image="performanceBarBg"
          />
        </div>
        <div>
          <p class="text-sm">
            <a
              href="https://github.com/rolldown/benchmarks/tree/f3997c801b7d261e8aaa15d4affbf6730cc19884?tab=readme-ov-file#ubuntu-latest-updated-2025-12-21"
              target="_blank"
              class="text-white font-medium"
              >基准测试</a
            >
            打包 <span class="text-white font-medium">19k</span> 个模块。
          </p>
          <p class="text-xs">
            1 万个 React JSX 组件 + 9000 个 iconify JS 文件，包含压缩与 sourcemap。
          </p>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-3 border-r-0 justify-between overflow-hidden">
      <div class="p-5 sm:p-15 sm:pb-10 flex flex-col gap-3">
        <h5 class="text-white">兼容 Rollup</h5>
        <p class="max-w-120 text-pretty">熟悉的 API 与选项，加上丰富的插件生态</p>
      </div>
      <div class="relative px-5 sm:px-20 pt-5 sm:pt-10 flex justify-center bg-[#ed4d01]">
        <img
          class="absolute inset-0 h-full w-full object-cover"
          src="@assets/rolldown/rolldown-rollup-background.jpg"
          alt=""
          inert
          loading="lazy"
        />
        <img
          src="@assets/rolldown/rolldown-rollup.png"
          width="892"
          height="555"
          class="-mb-[60px] z-1"
          inert
          loading="lazy"
          alt="兼容 Rollup"
        />
      </div>
    </div>

    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-white">与 esbuild 特性对齐</h5>
        <p class="max-w-104 text-pretty">
          内置转换、define、inject、压缩、CSS 打包等功能应有尽有……
        </p>
      </div>
      <div class="flex-1 flex items-center justify-center p-8 sm:p-15 sm:pt-10">
        <img
          src="@assets/rolldown/rolldown-esbuild-parity.png"
          width="742"
          height="493"
          inert
          loading="lazy"
          alt="与 esbuild 特性对齐"
          class="w-full max-h-60 object-contain"
        />
      </div>
    </div>

    <div class="flex flex-col gap-3 justify-between">
      <div class="p-5 sm:p-15 pb-0 sm:pb-0 flex flex-col gap-3">
        <h5 class="text-white">为 Vite 而生</h5>
        <p class="max-w-100 text-pretty">驱动 Vite 8+ 的统一打包器</p>
      </div>
      <RiveAnimation
        :desktop-src="vitePoweredAnimation"
        :desktop-width="640"
        :desktop-height="300"
        canvas-class="w-full mb-10"
      />
    </div>
  </section>
</template>
