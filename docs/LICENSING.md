# GPL 许可与旧版 MIT 权利

自 `0.4.0` 起，Tangrow 采用 **GNU GPL 第 3 版或任何后续版本**（`GPL-3.0-or-later`）。[LICENSE](../LICENSE) 保留标准 GPLv3 全文；项目版权声明、生效版本和附加许可放在 [NOTICE](../NOTICE)，不改写 GPL 正文。此前本地拟定的专有商业许可草案由此方案替代，不再要求购买授权、单用户席位或设备数量限制。

## 可以如何使用

- 可以免费用于个人工作，也可以用于商业工作。
- 可以获取、研究和修改源码；仅供自己使用的修改不要求向公众发布。
- 可以免费或收费再分发，但必须满足 GPL 对相应形式的分发条件，包括保留适用声明和提供对应源码。
- 分发 GPL 覆盖的修改作品时，应继续提供 GPL 赋予接收者的权利，不能另加“不得复制、不得再分发、不得转售”等限制。
- GPL 不保证维护、更新或支持，也不要求每个人都必须向任何人提供副本；提供副本时须遵守其条件。

## 生效版本和既有授权

| 范围 | 适用规则 |
| --- | --- |
| 首次 GPL 版本 | `0.4.0`，适用 GPLv3 或任何后续版本 |
| 已实际按 MIT 发布的材料 | 原 MIT 授权继续有效，不因新版本改用 GPL 而收回 |
| 旧版公开参考 | [`47549973f5f8a5157f7849468223aad942f9ce20`](https://github.com/tangwz/tangrow/tree/47549973f5f8a5157f7849468223aad942f9ce20) 及其已按 MIT 发布的历史 |
| 原 MIT 全文 | [LICENSE-MIT-LEGACY](../LICENSE-MIT-LEGACY)，与原声明逐字节一致 |
| 第三方组件及其他独立有效授权 | 各自许可和既有权利继续适用，不因项目更换许可证而失效 |

实际材料及授权记录决定边界，不能只根据版本号判断。旧版 MIT 材料仍可按 MIT 条件复制、修改、分发和销售；包含新增 GPL 内容的完整新作品则须满足其适用的 GPL 条件。保留旧 MIT 文件不表示整个新版本同时采用 MIT。若曾独立授予其他有效许可，其已有权利同样不因本次变更被收回。

## Obsidian 宿主和生成内容

Tangrow 通过宿主插件 API 调用 Obsidian。在 GPL 第 7 节允许的范围内，`NOTICE` 额外允许将 Tangrow 与 Obsidian 及其插件 API 链接或组合，作为 Obsidian 插件使用和分发，不要求仅因这种组合就把 Obsidian 源码纳入 Tangrow 的对应源码。该许可不授权重新分发 Obsidian 本体，也不免除 Tangrow 自身的 GPL 义务。贡献者可以按其授权范围保留或扩展附加许可；GPL 第 7 节允许的移除规则仍适用。

用户自己的笔记、附件和数据不会因为使用插件就变成 GPL 作品。对正常生成的 Markdown 与 Bases 输出中属于 Tangrow 权利人的部分，`NOTICE` 另行允许按用户选择的条款使用、修改和分享；这一输出许可不扩展到插件实现代码或独立的第三方素材。

## 安装包和对应源码

安装器与插件 ZIP 保留以下七个文件：

```text
manifest.json
main.js
styles.css
LICENSE
NOTICE
LICENSE-MIT-LEGACY
THIRD_PARTY_NOTICES.md
```

插件 ZIP 不是完整对应源码的替代品。发布二进制时，应采用 GPL 允许的方法提供与该二进制实际对应的完整源码，包括 TypeScript、语言资源、样式、构建配置、包元数据与锁文件，以及重建所需脚本。开发工具和独立宿主的处理按适用的 GPL 条款及宿主附加许可判断。

对 GitHub 发布，维护者应提交实际构建使用的源码并创建对应发布标签，在同一发布位置提供该版本源码的获取方式；不能只链接到可能已经变化的主分支，也不能用缺失本地修改的旧标签冒充对应源码。当前打包命令生成的是插件安装 ZIP，发布者仍须落实对应源码的提供方式。后续分发者也可以采用 GPL 允许的其他交付方式。

包元数据使用标准 SPDX 标识，构建首部同时提示查看 `NOTICE` 中的附加许可及既有权利：

```json
{
  "version": "0.4.0",
  "license": "GPL-3.0-or-later"
}
```

## 交付验证

以下检查需要 Node.js、npm 及系统 `zip`、`unzip`：

```sh
node --import tsx --test tests/install.test.ts tests/package.test.ts
npm run build
npm run package
git diff --check
```

预期为安装、备份和 ZIP 均保留 GPL、项目附加声明、历史 MIT 和第三方声明；缺少任一声明时在写入前失败。旧 MIT、旧专有许可或版本不符的运行文件不能被打包为当前 GPL 版本。归档检查不自动证明实际发布地点已经提供完整对应源码。

维护依据：[GNU GPL 正文](https://www.gnu.org/licenses/gpl-3.0.html)、[GNU 许可使用说明](https://www.gnu.org/licenses/gpl-howto.en.html)、[GNU 关于闭源宿主插件的说明](https://www.gnu.org/licenses/gpl-faq.en.html#GPLPluginsInNF)。具体义务以适用的 GPL、独立许可及法律为准。
