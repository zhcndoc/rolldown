import { extendConfig } from '@voidzero-dev/vitepress-theme/config';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type DefaultTheme, defineConfig } from 'vitepress';
import { groupIconMdPlugin, groupIconVitePlugin } from 'vitepress-plugin-group-icons';
import llmstxt from 'vitepress-plugin-llms';
import { addOgImage } from 'vitepress-plugin-og';
import { graphvizMarkdownPlugin } from 'vitepress-plugin-graphviz';
import { createHooksGraphProcessor } from './markdown-hooks-graph.ts';

const sidebarForGuide: DefaultTheme.SidebarItem[] = [
  {
    text: '指南',
    items: [
      { text: '简介', link: '/guide/introduction.md' },
      { text: '快速开始', link: '/guide/getting-started.md' },
      { text: '特色功能', link: '/guide/notable-features.md' },
      {
        text: '故障排查',
        link: '/guide/troubleshooting.md',
      },
    ],
  },
  {
    text: '深入了解',
    collapsed: true,
    items: [
      { text: '为什么需要打包器', link: '/in-depth/why-bundlers.md' },
      {
        text: '为什么需要插件 Hook 过滤器',
        link: '/in-depth/why-plugin-hook-filter.md',
      },
      { text: '模块类型', link: '/in-depth/module-types.md' },
      { text: '外部模块', link: '/in-depth/external-modules.md' },
      { text: '指令', link: '/in-depth/directives.md' },
      { text: '自动代码分割', link: '/in-depth/automatic-code-splitting.md' },
      { text: '手动代码分割', link: '/in-depth/manual-code-splitting.md' },
      { text: '打包 CJS', link: '/in-depth/bundling-cjs.md' },
      {
        text: '非 ESM 输出格式',
        link: '/in-depth/non-esm-output-formats.md',
      },
      { text: '顶层 Await', link: '/in-depth/tla-in-rolldown.md' },
      { text: '死代码消除', link: '/in-depth/dead-code-elimination.md' },
      { text: '懒加载 Barrel 优化', link: '/in-depth/lazy-barrel-optimization.md' },
      { text: '原生 MagicString', link: '/in-depth/native-magic-string.md' },
    ],
  },
  {
    text: '术语表',
    collapsed: true,
    items: [
      { text: 'Barrel 模块', link: '/glossary/barrel-module.md' },
      { text: '入口', link: '/glossary/entry.md' },
      { text: '入口 Chunk', link: '/glossary/entry-chunk.md' },
      { text: '入口名称', link: '/glossary/entry-name.md' },
      { text: '用户定义入口', link: '/glossary/user-defined-entry.md' },
    ],
  },
];

const sidebarForApi: DefaultTheme.SidebarItem[] = [
  {
    text: '接口',
    items: [
      { text: '打包器 API', link: '/apis/bundler-api.md' },
      {
        text: '插件 API',
        link: '/apis/plugin-api.md',
        items: [
          { text: 'Hook 过滤器', link: '/apis/plugin-api/hook-filters.md' },
          { text: '文件 URL', link: '/apis/plugin-api/file-urls.md' },
          { text: '源码转换', link: '/apis/plugin-api/transformations.md' },
          {
            text: '插件间通信',
            link: '/apis/plugin-api/inter-plugin-communication.md',
          },
        ],
      },
      { text: '命令行接口', link: '/apis/cli.md' },
    ],
  },
];

const sidebarForPlugins: DefaultTheme.SidebarItem[] = [
  {
    text: '内置插件',
    items: [
      {
        text: '简介',
        link: '/builtin-plugins/',
      },
      {
        text: 'builtin:bundle-analyzer',
        link: '/builtin-plugins/bundle-analyzer.md',
      },
      {
        text: 'builtin:esm-external-require',
        link: '/builtin-plugins/esm-external-require.md',
      },
      {
        text: 'builtin:replace',
        link: '/builtin-plugins/replace.md',
      },
    ],
  },
];

const importantAPIs: (string | undefined)[] = [
  '/Function.build.md',
  '/Function.rolldown.md',
  '/Function.watch.md',
  '/Interface.Plugin.md',
  '/Interface.PluginContext.md',
  '/Variable.VERSION.md',
  '/Function.defineConfig.md',
  '/Function.minify.md',
  '/Function.parse.md',
  '/Function.transform.md',
  '/Class.Visitor.md',
];

function getTypedocSidebar() {
  const filepath = path.resolve(import.meta.dirname, '../reference/typedoc-sidebar.json');
  if (!existsSync(filepath)) return [];

  try {
    return JSON.parse(readFileSync(filepath, 'utf-8')) as DefaultTheme.SidebarItem[];
  } catch (error) {
    console.error('Failed to load typedoc sidebar:', error);
    return [];
  }
}

const typedocSidebar = getTypedocSidebar().map((item) => {
  const stringifyForSort = (item: DefaultTheme.SidebarItem) =>
    (importantAPIs.includes(item.link) ? '0' : '1') + (item.text ?? '');
  return {
    ...item,
    base: '/reference',
    items: item.items
      ?.map((item) => ({
        ...item,
        text: (importantAPIs.includes(item.link) ? '★ ' : '') + item.text,
      }))
      .toSorted((a, b) => stringifyForSort(a).localeCompare(stringifyForSort(b))),
  };
});

function getOptionsSidebar() {
  const filepath = path.resolve(import.meta.dirname, '../reference/options-sidebar.json');
  if (!existsSync(filepath)) return [];

  try {
    return JSON.parse(readFileSync(filepath, 'utf-8')) as DefaultTheme.SidebarItem[];
  } catch (error) {
    console.error('Failed to load options sidebar:', error);
    return [];
  }
}

const sidebarForReference: DefaultTheme.SidebarItem[] = [
  {
    text: '选项',
    base: '/reference',
    items: getOptionsSidebar(),
    collapsed: false,
  },
  ...typedocSidebar,
];

const sidebarForDevGuide: DefaultTheme.SidebarItem[] = [
  {
    text: '贡献指南',
    items: [
      {
        text: '概览',
        link: '/contribution-guide/',
      },
      {
        text: '社区礼仪',
        link: 'https://developer.mozilla.org/en-US/docs/MDN/Community/Open_source_etiquette',
      },
    ],
  },
  {
    text: '开发指南',
    items: [
      {
        text: '项目搭建',
        link: '/development-guide/setup-the-project.md',
      },
      {
        text: '构建与运行',
        link: '/development-guide/building-and-running.md',
      },
      { text: '测试', link: '/development-guide/testing.md' },
      {
        text: '基准测试',
        link: '/development-guide/benchmarking.md',
      },
      {
        text: '追踪 / 日志',
        link: '/development-guide/tracing-logging.md',
      },
      {
        text: '性能分析',
        link: '/development-guide/profiling.md',
      },
      { text: '文档', link: '/development-guide/docs.md' },
      {
        text: '编码风格',
        link: '/development-guide/coding-style.md',
      },
    ],
  },
];

const sidebarForResources: DefaultTheme.SidebarItem[] = [
  {
    text: '团队',
    link: '/team.md',
  },
  {
    text: '致谢',
    link: '/acknowledgements.md',
  },
];

// https://vitepress.dev/reference/site-config
const config = defineConfig({
  title: 'Rolldown 中文文档',
  description: '基于 Rust 的快速 JavaScript 打包器，兼容 Rollup API',
  lastUpdated: true,
  cleanUrls: true,
  sitemap: {
    hostname: 'https://rolldown.zhcndoc.com',
  },
  head: [
    [
      'link',
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/logo-without-border.svg',
      },
    ],
    ['meta', { name: 'theme-color', content: '#ff7e17' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'zh-CN' }],
    [
      'meta',
      {
        property: 'og:title',
        content: 'Rolldown 中文文档 - 基于 Rust 的 JavaScript 打包工具',
      },
    ],
    [
      'meta',
      {
        property: 'og:image',
        content: 'https://rolldown.zhcndoc.com/og.jpg',
      },
    ],
    ['meta', { property: 'og:site_name', content: 'Rolldown 中文文档' }],
    ['meta', { property: 'og:url', content: 'https://rolldown.zhcndoc.com/' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:site', content: '@rolldown_rs' }],
    ['script', { async: '', src: 'https://www.zhcndoc.com/js/common.js' }],
  ],

  themeConfig: {
    variant: 'rolldown',
    search: {
      provider: 'algolia',
      options: {
        appId: process.env.ALGOLIA_APP_ID || '',
        apiKey: process.env.ALGOLIA_API_KEY || '',
        indexName: 'rolldown',
      },
    },

    banner: {
      id: 'viteplus-alpha',
      text: 'Vite+ Alpha 发布：开源、统一、现代化',
      url: 'https://viteplus.zhcndoc.com',
      target: '_blank',
    },

    // https://vitepress.dev/reference/default-theme-config
    nav: [
      {
        text: 'Guide',
        activeMatch: '/(guide|in-depth|glossary)',
        link: '/guide/getting-started.md',
      },
      { text: 'Reference', activeMatch: '/reference', link: '/reference' },
      {
        text: 'Plugins',
        activeMatch: '/builtin-plugins',
        link: '/builtin-plugins/',
      },
      {
        text: 'API',
        activeMatch: '/apis',
        link: '/apis/bundler-api.md',
      },
      { text: 'REPL', link: 'https://repl.rolldown.rs/' },
      {
        text: '资源',
        activeMatch: '/(team|acknowledgements|contribution-guide|development-guide)',
        items: [
          {
            text: '团队',
            activeMatch: '/(team|acknowledgements)',
            link: '/team.md',
          },
          {
            text: '参与贡献',
            activeMatch: '/(contribution-guide|development-guide)',
            link: '/contribution-guide/',
          },
          {
            text: 'Roadmap',
            link: 'https://github.com/rolldown/rolldown/discussions/153',
          },
        ],
      },
      { text: '简中文档', link: 'https://www.zhcndoc.com', target: '_blank' },
    ],

    sidebar: {
      // --- Guide (includes In-Depth and Glossary as collapsed sections) ---
      '/guide/': sidebarForGuide,
      '/in-depth/': sidebarForGuide,
      '/glossary/': sidebarForGuide,
      // --- Reference (options + typedoc dictionary) ---
      '/reference/': sidebarForReference,
      // --- Plugins ---
      '/builtin-plugins/': sidebarForPlugins,
      // --- API ---
      '/apis/': sidebarForApi,
      // --- Contribute ---
      '/contribution-guide/': sidebarForDevGuide,
      '/development-guide/': sidebarForDevGuide,
      // --- Resources ---
      '/team': sidebarForResources,
      '/acknowledgements': sidebarForResources,
    },
    outline: 'deep',
    socialLinks: [
      { icon: 'x', link: 'https://twitter.com/rolldown_rs' },
      {
        icon: 'bluesky',
        link: 'https://bsky.app/profile/rolldown.rs',
      },
      { icon: 'discord', link: 'https://chat.rolldown.rs' },
      { icon: 'github', link: 'https://github.com/rolldown/rolldown' },
    ],

    footer: {
      copyright: `© 2025-present VoidZero Inc. and Rolldown contributors.`,
      nav: [
        {
          title: 'Rolldown',
          items: [
            { text: 'Guide', link: '/guide/getting-started' },
            { text: 'Reference', link: '/reference' },
            { text: 'Plugins', link: '/builtin-plugins/' },
            { text: 'API', link: '/apis/bundler-api' },
            { text: 'Contribute', link: '/contribution-guide/' },
            { text: 'REPL', link: 'https://repl.rolldown.rs/' },
          ],
        },
        {
          title: '资源',
          items: [
            {
              text: '路线图',
              link: 'https://github.com/rolldown/rolldown/discussions/153',
            },
            { text: '团队', link: '/team' },
          ],
        },
        {
          title: '友情链接',
          items: [
            {
              text: '简中文档',
              link: 'https://www.zhcndoc.com',
              target: '_blank',
            },
            {
              text: '沪ICP备2024070610号-3',
              link: 'https://beian.miit.gov.cn',
              target: '_blank',
              rel: 'nofollow noopener noreferrer',
            },
          ],
        },
      ] as any,
      social: [
        { icon: 'github', link: 'https://github.com/rolldown/rolldown' },
        { icon: 'discord', link: 'https://chat.rolldown.rs' },
        { icon: 'bluesky', link: 'https://bsky.app/profile/rolldown.rs' },
        { icon: 'x', link: 'https://x.com/rolldown_rs' },
      ],
    },

    editLink: {
      pattern: 'https://github.com/zhcndoc/rolldown/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },
  },

  vite: {
    optimizeDeps: {
      exclude: ['@docsearch/css'],
    },
    plugins: [
      groupIconVitePlugin({
        customIcon: {
          homebrew: 'logos:homebrew',
          cargo: 'vscode-icons:file-type-cargo',
        },
      }) as any,
      llmstxt({
        ignoreFiles: ['development-guide/**/*', 'index.md', 'README.md', 'team.md'],
        description: 'Fast Rust-based bundler for JavaScript with Rollup-compatible API',
        details: '',
      }),
    ],
  },
  markdown: {
    async config(md) {
      md.use(groupIconMdPlugin);
      await graphvizMarkdownPlugin(md as any, {
        processors: { 'hooks-graph': createHooksGraphProcessor() },
      });
    },
  },
  async transformPageData(pageData, ctx) {
    // Disable "Edit this page on GitHub" for auto-generated reference docs
    if (pageData.relativePath.startsWith('reference/')) {
      pageData.frontmatter.editLink = false;
    }

    // Automatically handle OG images for all markdown files.
    if (!pageData.frontmatter.image && pageData.relativePath !== 'index.md') {
      await addOgImage(pageData, ctx, {
        domain: 'https://rolldown.zhcndoc.com',
        maxTitleSizePerLine: 16,
      });
    }
  },
});

export default extendConfig(config);
