# 桶模块

桶模块是一种从其他模块重新导出功能的模块，通常用于为包或目录创建更简洁的公共 API：

```js
// components/index.js（桶模块）
export { Button } from './Button';
export { Card } from './Card';
export { Modal } from './Modal';
export { Tabs } from './Tabs';
// ... 还有几十个组件
```

这使得使用者可以从单一入口点导入：

```js
import { Button, Card } from './components';
```

然而，桶模块可能会导致性能问题，因为打包工具传统上需要编译所有重新导出的模块，即使实际上只使用了其中少数几个。有关 Rolldown 如何解决这一问题，请参见 [懒加载桶优化](/in-depth/lazy-barrel-optimization)。
