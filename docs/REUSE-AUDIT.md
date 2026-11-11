# 发布前复用核查

核查日期：2026-11-09。对照 Tangrow `0.2.1` 与本地提供的 FLO.W 发布文件，未发现可识别的专有业务代码、成组样式、素材或模板直接复制证据。存在通用算法、构建辅助代码、常见 CSS 声明与短提示词的重合；本结论不等于独立创作、权属或不侵权的证明。

## 比较基线

| 项目 | 固定版本或范围 |
| --- | --- |
| Tangrow | [`e992ef101519425dc9e2a45c42c7c562ff289f81`](https://github.com/tangwz/tangrow/tree/e992ef101519425dc9e2a45c42c7c562ff289f81)，`0.2.1`，47 个跟踪文件 |
| FLO.W Core | `1.0.37` 的插件发布文件 |
| Calendar Bases | `0.2.8` 的插件发布文件 |
| 提供的笔记库 | 85 个文件的清单与指纹，包含 10 个 Markdown 模板、23 个 Bases |
| Tangrow 发布包 | 由固定基线构建的 ZIP，包含 5 个文件 |

本次是实现后的静态复用核查，读取了参考插件的已发布 JavaScript、CSS、模板和数据库配置；没有执行参考插件代码或使用其账号与授权机制。此前的[功能对照审计](PARITY-AUDIT.md)依据截图和宿主界面，回答功能覆盖问题，两者不能互相替代。

公开记录只保留非敏感统计、插件文件指纹与 Tangrow 源码定位，不附参考源文件、截图、私人文件清单、笔记正文、账户信息或本地绝对路径。

## 代码交集

使用 Acorn `8.19.0` 分词，以 40 个 token 作为连续段候选长度；移除标识符名称并保留字符串、数字、正则值，再进行保留成员属性名的第二轮对照。Tangrow 同时比较普通构建与压缩构建。函数体比较移除位置及字面量原始排版，保留属性、全局标识和字面量，检查至少 20 个 AST 节点的函数。

符合函数体比较条件的数量为 FLO.W Core 5,837 个、Calendar Bases 1,279 个、Tangrow 241 个。未发现完整专有业务函数的 AST 匹配；每个参考插件均有 2 个与 Tangrow 压缩产物相同的构建器辅助函数，应归入共同构建工具产生的代码。

| 归一化后的交集 | 长度 | Tangrow 基线位置 | 判断 |
| --- | --- | --- | --- |
| 公共前缀与后缀裁剪 | 79 tokens | [`src/main.ts:577`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/main.ts#L577) | 通用短算法，完整函数及后续处理不同 |
| 递归排序对象键的表达式 | 51 tokens | [`src/managed-files.ts:4`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/managed-files.ts#L4) | 表达式在标识符归一化后相同，不能据此推断来源 |
| 本地日期转 `YYYY-MM-DD` | 50 tokens | [`src/model.ts:25`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/model.ts#L25)、[`src/capture-data.ts:53`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/capture-data.ts#L53) | 常见日期格式化写法 |

这些长度用于定位和复核候选片段，不是法律上的独创性或实质性相似标准。改名、改格式或缩短片段不会自动解决实际的来源问题。

## 样式交集

比较三份 CSS 的连续 token、完整声明组合和声明集合，并替换插件选择器前缀、展开 Tangrow 的主题变量别名后复核。连续段筛选长度为 40 tokens；完整规则与集合相似度筛选还分别考虑至少 6 条声明、Jaccard 相似度 `0.7` 和至少 5 条共同声明。

Tangrow 与 FLO.W Core 最长连续相同片段为 21 tokens，与 Calendar Bases 为 13 tokens。实际交集集中在 Grid/Flex 布局、主题变量、单行省略与两行截断；没有识别出专有的成组规则复制。选择器更名后的相同声明组合也属于这些通用模式。CSS 相似度不能替代真实界面的视觉表达比较。

## 模板和文案

10 个参考模板与 23 个 Bases 未发现整文件复制。模板中含至少 6 个汉字的完整正文行，在 Tangrow 文本文件中无命中。对参考打包代码中的 Unicode 转义作静态解码后，15 条 Tangrow 本地化文案含有 6 至 10 个汉字的公共子串，均为短动作标签或错误提示，没有发现模板长段落或独特说明文复制。

参考模板以产品分类字段、状态路由及中文关联属性组织数据；Tangrow 使用 `tangrow_` 属性。Tangrow 的项目创建只生成通用 YAML 与标题外壳，没有采用参考项目模板中的目标提示和关联查询；日记也没有采用参考周期模板的身份与正文结构。对应基线位置为 [`src/main.ts:401`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/main.ts#L401)、[`src/main.ts:625`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/main.ts#L625) 和 [`src/bases.ts:136`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/bases.ts#L136)。公开 Bases 语法、常见日期格式与普通分类词本身不构成直接复制的充分证据。

## 素材与发布包

Tangrow 基线没有独立图片、字体或音视频资源，源码与产物中未检测到内嵌 SVG、字体或图片素材；图标通过 Obsidian `setIcon` 获取。两组输入没有整文件 SHA-256 相同的文件。参考插件的第三方组件声明不等于对其整体产品的复用授权；本次也未找到该整体产品可供再分发的许可。

已检查的 Tangrow ZIP 只包含 `manifest.json`、`main.js`、`styles.css`、`LICENSE` 和 `THIRD_PARTY_NOTICES.md`，没有额外模板、截图、参考插件或来源映射文件。ZIP 指纹用于标识当时的归档文件，不代表 ZIP 元数据可确定性重建。

| 基线文件 | SHA-256 |
| --- | --- |
| FLO.W Core `main.js` | `4e5f9d247a57ac6a2fc875e336198a5d0151a570b64e19a7ef8c3c6dc9eb2a86` |
| FLO.W Core `styles.css` | `ed161c7d8f315172c3cc607a9ef072e051160ede8517c8fd1421336db60f34b1` |
| Calendar Bases `main.js` | `bb520ecd207d562ae138b4c0fd4481ff60c8958f051ecabf02b7fe9d04399c3e` |
| Calendar Bases `styles.css` | `47bae2888c04cead75dddba1665f47bee181244811a6d77fc26d7fe1d5aa6c03` |
| Tangrow 构建 `main.js` | `80b1107ee9fa65e37d9941958dcbafab5afff53b705ab93b19f5394f81bef3f7` |
| Tangrow `styles.css` | `f4cf38fda607a5f756ff0b2df0151e794f1091f6d0e6c2e3acd23f371a0f299e` |
| Tangrow `LICENSE` | `4d33523bddbb6bddec832d636e65bded09da9887c0bddefba1abb79b02de461f` |
| Tangrow `THIRD_PARTY_NOTICES.md` | `989046435d0ac43d116077cd485af06a6cfca9933ca7721f1ce9895af5e719c0` |
| Tangrow `0.2.1` ZIP | `24feb93066c334d033bc5516f2bddcd60f0b00b867203559582fde4c54365eeb` |

## 发布问题与后续验证

| 基线问题 | 影响 | 基线定位 |
| --- | --- | --- |
| 多个写作视图独立缓存正文 | 旧视图输入可能覆盖较新的共享草稿 | [`src/sidebar.ts:165`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/sidebar.ts#L165) |
| 辅助目录与内容目录缺少冲突校验 | 可能将用户笔记从统计中排除 | [`src/main.ts:261`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/src/main.ts#L261) |
| 安装器只复制三个运行文件 | 转交已安装目录时可能遗漏完整许可声明 | [`scripts/install.mjs:63`](https://github.com/tangwz/tangrow/blob/e992ef101519425dc9e2a45c42c7c562ff289f81/scripts/install.mjs#L63) |

后续 `0.2.2` 改动对草稿增加共享版本及中文组字保护；对目录修改增加完整配置验证，保留旧配置并提供迁移到库根 `99-Tangrow` 的显式入口；安装器补充两个许可声明。回归入口及其范围见[功能对照审计的发布前修复](PARITY-AUDIT.md#发布前修复)。这些是本次基线发现之后的修复，不能用基线 ZIP 的指纹或静态结果替代新版本发布包与实际界面的验收。

分发时还需保留代码及素材来源记录，按实际功能描述产品，不使用参考产品的名称、标识或素材暗示授权关系。本次 `0.2.1` 审计基线采用的 [MIT](../LICENSE-MIT-LEGACY) 允许商业分发，也允许接收方按许可条件继续再分发；它不会授予项目对第三方内容原本没有的权利。`0.4.0` 起采用 GPLv3 或任何后续版本，历史 MIT 权利保留；具体边界及对应源码说明见 [LICENSING.md](LICENSING.md)，不追溯改写本次基线。

## 结论边界

参考产品的原始 TypeScript 与 source map 不在输入中，函数和 token 方法不能排除大幅改写后的语义复用。此次没有做真实界面逐屏并排比较，也未核验用户购买协议或首个提交之前的开发记录。因此，本次只支持固定基线下的静态技术判断，不能证明创作过程、版权归属、合同合规或全部司法辖区下的不侵权。
