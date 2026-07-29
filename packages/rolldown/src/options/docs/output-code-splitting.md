:::warning

请注意，手动代码拆分如果在相应模块实际被使用之前触发了副作用，可能会改变应用程序的行为。你可以更改分块配置以将对顺序敏感的模块保留在一起，或者使用 [`output.strictExecutionOrder`](https://rolldown.rs/reference/OutputOptions.strictExecutionOrder) 选项来保持源代码的执行顺序。该选项会对模块进行包装，使其主体按源代码顺序运行，但会增加 bundle 体积成本；`experimental.onDemandWrapping` 用基于预测的分块执行风险得出的保守方案替代了全量包装。

:::
