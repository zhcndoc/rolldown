# Chunk Hash

## 摘要

每个输出 chunk 的文件名都可以包含一个 `[hash]` token，调用方通常期望它是一个**内容可寻址**的标识符：相同内容（跨构建、跨机器、跨配置）→ 相同 hash → 相同文件名。这使得 HTTP 缓存、不可变部署以及 CDN 缓存固定成为可能。

这个机制必须同时满足三个不变性：

1. **跨构建稳定。** 添加或移除一个无关的 chunk，不能改变任何其自身字节未变化的 chunk 的 hash。
2. **对真实内容敏感。** 任何对 chunk 字节的修改——或者对其传递依赖的 chunk 的修改——都必须改变它的 hash。
3. **构建内唯一性。** 两个不同的 chunk 如果会解析成同一个文件名，最终必须拥有不同的 hash。

这三者相互牵制，而这里描述的设计本质上与 Rollup 相同。非显而易见的部分在于：当 chunk 内容通过名字相互引用时，如何满足 #1，以及如何解决 #2 和 #3 之间罕见的冲突。

## 流程

hash 计算位于 `crates/rolldown/src/utils/chunk/finalize_chunks.rs::finalize_assets`。在它运行时，每个 chunk 都已经被渲染成字符串，并且每个 chunk 都已经被分配了一个**初步文件名**，例如 `entries/main-!~{001}~.js` —— 其中的 `!~{001}~` 是一个 hash 占位符，见下文。

```
[render chunks]
  ↓ chunk.content (string) + chunk.preliminary_filename (with placeholder)
[finalize_assets]
  ├─ Phase 1 (parallel):  per-chunk standalone content hash
  ├─ Phase 2 (parallel):  per-chunk final hash = own standalone + transitive deps' standalone
  ├─ Phase 3 (sequential): deconflict file names by rehashing on collision
  └─ replace placeholders in content + filename with final hashes
```

## Hash 占位符

hash 占位符是一个固定形状的字符串 `!~{<index>}~`，由 `HashPlaceholderGenerator`（`crates/rolldown_utils/src/hash_placeholder.rs`）在 rolldown 需要在 chunk 的最终 hash 尚未知晓时先输出一个对该 chunk 的引用时注入。它会出现在两个地方：

- **在 `preliminary_filename` 中。** 像 `entries/[name]-[hash].js` 这样的模板，在分配占位符后会变成 `entries/main-!~{001}~.js`。
- **在 chunk 内容中。** 任何 emitter 写出跨 chunk 的 import 路径时——`crates/rolldown_common/src/chunk/mod.rs` 中的 `import_path_for(importee_chunk)`——都会把被导入 chunk 的 `absolute_preliminary_filename`（其中包含它自己的占位符）拼接进生成的代码里：
  ```js
  import { x } from './chunk-shared-!~{002}~.js';
  ```

占位符的**形状是稳定的**（长度相同，`!~{` / `}~` 定界符相同，仅 ASCII）。占位符的**索引不稳定**——它取决于 chunk 被渲染的顺序，而这个顺序又取决于 chunk 图；当 entry 增加/移除时，chunk 图会变化。

在所有最终 hash 计算完毕之后，`finalize_assets` 的最后一步会把这个索引替换为真实 hash。

## 第 1 阶段：独立内容 hash

```rust
let mut hasher = Xxh3::default();
visit_with_placeholders_defaulted(
  content,
  &HASH_PLACEHOLDER_LEFT_FINDER,
  |placeholder| ins_chunk_idx_by_placeholder.contains_key(placeholder),
  |bytes| hasher.update(bytes),
);
let standalone = to_url_safe_base64(hasher.digest128().to_le_bytes());
```

`visit_with_placeholders_defaulted`（位于 `rolldown_utils::hash_placeholder`）会遍历 `content`，并按顺序把字节送入 `hasher.update`。每一个 rolldown 自己生成的 `!~{xxx}~`（谓词会通过 `ins_chunk_idx_by_placeholder` 去查找它）都会在送入哈希前被规范化为 `!~{000...}~`（同样的形状，索引全 0）；而用户源代码中碰巧符合占位符形状的字面量则会按原样参与哈希，这样其字节变化仍会反映到 hash 中。这与 Rollup 的 `replacePlaceholdersWithDefaultAndGetContainedPlaceholders` 一致，后者执行的是相同的 `placeholders.has(placeholder)` 检查。

这对应不变性 #1（稳定性）：chunk 自身的 hash 现在只依赖于它的真实字节和跨 chunk 引用的 _形状_，而不依赖那些短暂的索引值。

**流式处理，而不是物化。** Chunk 可能有几十 MB。若为每个 chunk 先物化一个规范化后的 `String`，每次构建都会额外分配接近整个 bundle 大小的临时缓冲区。`visit_with_placeholders_defaulted` 是针对 `&[u8]` 切片的 visitor；hasher 直接消费这些切片。Rollup 的对应实现（`replacePlaceholdersWithDefaultAndGetContainedPlaceholders`）会先物化字符串再哈希——rolldown 刻意没有这样做。

**augmentChunkHash。** 如果用户插件提供了 hash 增强内容，它会被追加到 standalone hash 字符串之后，然后对整体重新哈希（`xxhash_base64_url(hash.as_bytes())`）。这与 Rollup 保持一致。

## 第 2 阶段：最终 hash

```rust
let mut hasher = Xxh3::default();
standalone_content_hashes[chunk_idx].hash(&mut hasher);
for dep_idx in transitive_dependencies[chunk_idx] {
  standalone_content_hashes[dep_idx].hash(&mut hasher);
}
let final_hash = encode_hash_with_base(hasher.digest128().to_le_bytes(), hash_base);
```

`transitive_dependencies` 是通过从每个 chunk 的内容中提取占位符（占位符指向其他 chunk），然后求传递闭包得到的。对每个传递依赖的 _standalone_ hash 进行哈希，意味着：

- 如果 chunk `B` 发生变化，那么所有在传递依赖链上依赖 `B` 的 chunk 都会得到新的最终 hash——满足不变性 #2。
- 如果只是一 个无关 chunk 的索引发生偏移，那么没有被传递到的 chunk 不会看到不同的输入——不变性 #1 仍然成立。

chunk 的 `preliminary_filename` **刻意不参与这个 hash**。早期设计曾经把它混入（`#1141`），以保证构建内唯一性，但 `preliminary_filename` 里的占位符索引恰恰是我们希望排除的那个不稳定输入。唯一性由第 3 阶段单独保证。

## 第 3 阶段：消解文件名冲突

在第 2 阶段之后，两个字节完全相同且传递依赖也完全相同的 chunk 会产生相同的最终 hash。如果它们的初步文件名模板也解析成同一个字符串（例如都为 `entry-!~{XXX}~.js`，且没有 `[name]` token），它们就会在磁盘上冲突。

`deconflict_filenames` 会按确定性的顺序遍历 chunk，解析每个候选文件名，并在冲突时**重新哈希冲突的 chunk**（`Xxh3(prev_hash_string)`）再试一次。比较是大小写不敏感的（HFS+/NTFS）。

```rust
for chunk in chunks_in_order {
  loop {
    let candidate = resolve_filename(chunk.preliminary_filename, chunk_hash);
    if taken.insert(candidate.to_lowercase()) { break; }
    chunk_hash = rehash(chunk_hash);  // hash 的 hash
  }
}
```

这是整个流程中唯一的顺序执行阶段。它几乎逐行对应 Rollup 的 `generateFinalHashes`（在 `src/utils/renderChunks.ts` 中），包括大小写不敏感的冲突集合。

Rollup 中有一个针对这个确切情况的回归测试：`test/chunking-form/samples/hashing/deconflict-hashes`：两个字节完全相同的 entry + `entryFileNames: 'entry-[hash].js'` → 两个不同的文件名。

在实践中，这种冲突很少见，因为默认值为 `Simple` 的 `experimental.attachDebugInfo` 会向渲染后的 chunk 注入一个 `//#region <module.debug_id>` 标记，这会根据模块路径区分内容。通过 `experimental.attachDebugInfo: 'none'` 禁用调试信息的用户，才更可能触发这种冲突并依赖这个循环。

## 为什么不直接对初步文件名做 hash

一个诱人的替代方案是：在对初步文件名的占位符做规范化之后，把初步文件名混入最终 hash —— 这样对于 chunk 名称不同的 chunk，就无需再进行 rehash 循环，也能满足唯一性。

它几乎可行，但会在 `deconflict-hashes` 场景下失败：当两个 chunk 具有**相同的 chunk 名称**，而模板是 `[hash].js`（没有 `[name]`）时，它们规范化后的初步文件名字节完全相同（`!~{000}~.js`），hash 仍然会冲突。重新哈希循环才是正确的修复方式，因为它作用于解析后的文件名，而不是作用于模板本身。

## debug_id

`ecma_meta.debug_id`（用于在 source map 中为 Sentry 等输出 `//# debugId=...`）会被设置为与第 2 阶段生成的同一个 `u128` digest。这意味着 debug ID 也共享 hash 的稳定性属性——相同内容 → 跨构建相同 debug ID，这对 sourcemap 关联非常有用。发生冲突并重新哈希的 chunk 自然也会得到不同的 debug ID。

## 已知限制

**第 3 阶段的 rehash 不会回传给导入者。** 第 2 阶段会把每个传递依赖的 _standalone_ hash（即 deconflict 之前的 hash）累加进导入者的最终 hash。如果第 3 阶段为了避免文件名冲突而把依赖 `B` 重新哈希，`B` 的导入者 `A` 最终在 import specifier 中会发出 `B` 重新哈希后的文件名——但 `A` 自己的最终 hash 是基于 `B` 重新哈希前的 standalone hash 计算出来的，所以 `A` 的 `[hash]` 并不会反映这一变化。相同输入 + 相同配置会产生相同的 deconflict 顺序，因此发出的字节也相同（在某个配置内是确定性的），但仅仅因为某些会改变字节完全相同 chunk 的 `InsChunkIdx` 顺序的因素而不同的两个构建（例如用户在 `input` 中重新排列 entries），可能会让 `A` 发出不同的字节，同时保持 `A` 的 `[hash]` 不变。Rollup 的 `generateFinalHashes` 也表现出同样的行为（其 `contentToHash` 累加的是 deconflict 之前的 `contentHash`，而不是 deconflicted 的最终 hash），因此若要修复这一点，就需要偏离参考实现，并按拓扑顺序处理 chunk，让导入者依赖导入对象 deconflict 之后的 hash。要触发这个问题，需要存在能被某个导入者引用的字节完全相同的 chunk（很少见），并且使用仅有 `[hash]` 的模板（也同样很少见）。

## 文件

- `crates/rolldown/src/utils/chunk/finalize_chunks.rs` — `finalize_assets`, `deconflict_filenames`, `resolve_filename`, `rehash`
- `crates/rolldown_utils/src/hash_placeholder.rs` — `HashPlaceholderGenerator`, `find_hash_placeholders`, `visit_with_placeholders_defaulted`, `replace_placeholder_with_hash`
- `crates/rolldown_common/src/chunk/types/preliminary_filename.rs` — `PreliminaryFilename`（字符串 + 拥有的占位符列表）
- `crates/rolldown_utils/src/xxhash.rs` — `encode_hash_with_base`, `xxhash_base64_url`

## 相关

- Rollup 参考实现：[`src/utils/renderChunks.ts`](https://github.com/rollup/rollup/blob/master/src/utils/renderChunks.ts)（`transformChunksAndGenerateContentHashes`、`generateFinalHashes`）
- Issue [#9339](https://github.com/rolldown/rolldown/issues/9339) —— 促使将独立内容哈希中的占位符规范化移除的 bug
