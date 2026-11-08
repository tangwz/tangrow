# 第三方许可

Tangrow 的运行包只包含独立实现及对 Obsidian 宿主 API 的调用。`obsidian` 在构建中标记为 external，不随运行包分发；图标通过宿主 `setIcon` 获取，没有复制或打包 SVG。Obsidian 应用本体、名称和内置资源仍归各自权利人所有，本项目不表示获得官方背书。

以下为当前直接开发依赖的许可证记录；精确版本由 `package-lock.json` 固定。开发依赖的许可证继续适用于其自身，不因 Tangrow 的 MIT 许可而改变。

| 依赖 | 当前安装版本 | 许可 | 来源 |
| --- | --- | --- | --- |
| obsidian | 1.14.4 | MIT | [obsidian-api](https://github.com/obsidianmd/obsidian-api) |
| esbuild | 0.28.2 | MIT | [esbuild](https://github.com/evanw/esbuild) |
| typescript | 5.9.3 | Apache-2.0 | [TypeScript](https://github.com/microsoft/TypeScript) |
| tsx | 4.23.15 | MIT | [tsx](https://github.com/privatenumber/tsx) |
| @types/node | 24.19.2 | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) |

Obsidian API 类型定义许可如下，源自其 [LICENSE.md](https://github.com/obsidianmd/obsidian-api/blob/master/LICENSE.md)：

```text
Copyright 2022 Dynalist Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

若未来新增字体、图片、独立图标包或运行时依赖，应同步更新本文件并保留其要求的版权和许可文本。
