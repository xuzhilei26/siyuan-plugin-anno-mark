# AnnoMark 图片标注

在思源笔记里右键图片即可打开完整标注编辑器：21 种工具、背景合成、232 项图片效果（213 项原生逐像素实现，可逐项调参、叠加）、50 步撤销，导出结果写回文档，且随时可以再次打开继续编辑。

- 插件名 / 目录名：`siyuan-plugin-anno-mark`
- 版本：`1.0.0`（`plugin.json` 与 `package.json` 一致）
- 运行环境：思源桌面端（`plugin.json` 中 `frontends: ["desktop"]`），最低版本 `3.1.0`
- 技术栈：TypeScript + Canvas 2D，Vite 库模式构建，无运行时依赖

## 功能

### 21 个工具

工具栏自左向右：选择 `V`、矩形 `R`、椭圆 `E`、直线 `L`、箭头 `A`、自由画笔 `F`、文本 `T`、气泡 `O`、序号 `N`、插入图片 `I`、克隆 `D`、表情 `J`、光标 `K`、高亮 `H`、智能橡皮 `W`、模糊 `B`、马赛克 `P`、放大镜 `M`、聚光灯 `S`，分隔后为裁剪 `C`、抠图 `U`。

- 拖拽类工具（矩形/椭圆/直线/箭头/画笔/高亮/抠图/模糊/马赛克/放大镜/聚光灯/克隆）实时预览，位移小于 3px 视为误操作丢弃。
- 文本与气泡在画布上就地输入，`Enter` 提交、`Esc` 取消，空文本不落库；气泡可关闭尾巴。
- 序号按起始序号自动递增，支持数字/字母/罗马数字三种样式。
- 插入图片等比放置并可拖动；表情面板提供 12 个常用 emoji。
- 光标工具在点击处插入光标标注，可在属性条切换箭头/手形/文本/十字四种光标样式（类型随标注保存），可拖动；智能橡皮点击或拖拽擦除命中的标注，一次拖拽只记一步历史。
- 放大镜按强度放大区域，聚光灯挖洞压暗并按柔化值羽化，两者均可切换圆形/矩形。
- 裁剪拖出选区后按 `Enter` 应用；抠图直接抠出矩形区域。

### 上下文属性条

浮动工具栏下方按当前工具或选中标注的类型显隐 14 组属性控件：

1. 颜色：边框 / 填充 / 文字，24 色板 + 十六进制输入 + 原生取色器 + 透明
2. 线宽（1 / 2 / 3 / 4 / 6 / 8 / 12）
3. 边框样式（实线 / 虚线 / 点线 / 点划线）
4. 圆角（0–50）
5. 字体与字形（6 款字体 + 加粗 / 斜体）
6. 字号（12–72）
7. 对齐（左 / 中 / 右）
8. 序号（类型与起始序号）
9. 强度（10–100）
10. 聚光柔化（0–30）
11. 区域形状（圆形 / 矩形）
12. 气泡尾巴开关
13. 光标样式（箭头 / 手形 / 文本 / 十字，仅光标工具与选中光标标注时可见）
14. 阴影（开关 + 颜色 + 模糊 + 透明度 + 水平/垂直偏移）

其余弹层为线段预览、滑杆或开关，修改即时生效并压入历史；无选中时只更新默认样式，有选中时改选中标注。

### 左侧背景面板

外边距（0–200，默认 24）、内边距（0–200，默认 0，可与外边距联动）、智能内边距、圆角（0–50，默认 8）、阴影半径（0–100，默认 30）、比例九宫格（自动 / 1:1 / 4:3 / 3:2 / 16:9 / 5:3 / 9:16 / 3:4 / 2:3）、背景类型四选一：纯色、渐变（8 组预设 + 自定义起止色）、本地图片铺满、棋盘格（10px 灰白棋盘，与绘制类 `draw_checkerboard` 同一配色与格距）。背景参与导出合成，屏幕与导出结果一致。

### 右侧效果面板（4 分类 232 项）

效果目录与 ShareX.ImageEditor 3.x 对齐，按 4 个可折叠分组收录 232 项：操作 34、调整 32、滤镜 153、绘制 13。其中 213 项在 `src/effects/impl/` 内按参数逐像素实现（A 级 103 项、B 级 110 项），19 项 C 级条目直接复用编辑器已有的裁剪、缩放、翻转、旋转、背景与绘制工具；30 项边框/画框/窗口/阴影类效果会扩大输出画布。

- 分组标题带数量徽标，搜索框同时匹配译名、英文名与原始 id，过滤后隐藏空分组并显示匹配总数；已应用的效果在目录中保持高亮。
- 面板上方是「已应用效果」栈列表，按应用顺序显示序号、名称与参数摘要，每项支持编辑、上移、下移、移除，标题栏的「清空」在栈为空时禁用。
- 点击带参数的效果会打开参数面板：数字为滑杆加数值输入，颜色为取色器加十六进制（默认带 8 位时附带透明度），布尔为开关，枚举为下拉，另有文本框与本地图片选择；6 个以内参数且高度低于视口 60% 时使用锚定弹层，超出时（如 `text_watermark` 的 24 个参数）改用居中可滚动模态。改动实时预览（约 60ms 防抖），取消回滚预览，应用才写入效果栈；无参数的效果点击即应用。
- 预览按长边 1600px 下采样渲染，导出时按原始分辨率重跑整条栈；渲染结果按底图、参数栈与尺寸缓存。效果变更与标注共用同一个 50 步撤销栈。
- 内容概览：操作为裁剪/缩放/翻转/旋转等几何委托项，以及万花筒、鱼眼、页面卷曲、镜像拼贴等变形；调整为亮度、对比度、曝光、清晰度、去雾、通道交换、色彩矩阵等；滤镜覆盖模糊、锐化、边框、辉光、噪点、ASCII 艺术、故障块状等；绘制提供粒子、雪花、彩纸、水印、渐变叠加等图元。

### 底部命令栏

缩放（25% / 50% / 75% / 100% / 150% / 200% / 适应窗口）、撤销、重做、取消、继续（保存并关闭）、复制、保存、另存、钉住、打印、上传。撤销/重做按钮随历史可退/可进而实时切换禁用态；钉住与上传在思源环境不可用，呈禁用态并提示原因。

### 文件菜单与右键菜单

- 文件菜单：新建（空白画布）、打开（本地图片替换底图）、最近（本会话最近 5 张）、保存、另存、复制、打印、退出；不可用项自动禁用。
- 右键菜单：撤销、重做、删除所选、清除全部标注、复制标注、复制图片、切换工具栏、适应窗口、实际大小。

### 历史

标注、背景与效果的每次变更压入 50 步历史，自动截断重做栈；相同快照不会产生空步，撤销/重做按钮禁用态实时同步。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `V` / `R` / `E` / `L` / `A` / `F` / `T` / `O` / `N` / `I` / `D` / `J` / `K` / `H` / `W` / `B` / `P` / `M` / `S` / `C` / `U` | 依次切换 21 个工具 |
| `Ctrl+Z` | 撤销 |
| `Ctrl+Shift+Z` 或 `Ctrl+Y` | 重做 |
| `Delete` / `Backspace` | 删除选中的标注 |
| `Ctrl+D` | 复制选中的标注并偏移 16px |
| `Ctrl+C` | 复制合成图片到剪贴板 |
| `Ctrl+X` | 剪切选中的标注（复制到剪贴板后删除） |
| `Ctrl+S` | 保存 |
| `Ctrl+Shift+S` | 另存 |
| `Esc` | 逐级退出：关闭弹层 → 取消裁剪 → 取消文字输入 → 取消选中；无层级可退时才关闭对话框（有未保存修改会先确认） |
| `Enter` | 应用裁剪选区 |

输入框聚焦时快捷键不会触发画布操作。

## 保存与再编辑

### 保存分支

- **PNG 原地覆盖**：按输出像素合成 → 嵌入 v2 元数据 → 覆盖原 `assets/...` 文件 → 刷新文档中引用该图片的 `img`（追加 `?v=` 时间戳）→ 关闭对话框并提示。
- **JPEG / WebP 另存**：写出 `assets/<stem>-anno-<blockId>.png`，在图片块之后插入 `![](...)` 新块，原文件不变；若定位不到块 ID，只写入文件并提示手动插入。

### 元数据

PNG 的 `tEXt` 块使用关键字 `anno-mark`，内容为 `v:2` 工程数据：

```ts
{
  v: 2,
  plugin: "anno-mark",
  annotations: [...],   // 19 类标注（选择/裁剪不落标注，坐标存图片原始像素）
  effects: {
    stack: [{ id, params, seed }],   // 有序效果栈，按应用顺序执行
    rotate, flipX, flipY             // 0/90/180/270；flip 取 1 或 -1
  },
  bg: { margin, padding, smartPadding, corner, shadow, ratio, mode, ... },
  originalFileName, originalHash, savedAt
}
```

旧元数据中的 `effects.filters` / `effects.decorations`（没有 `stack` 数组时）会在读取时迁移为等效效果栈：`brightness` / `contrast` / `saturate` / `hue-rotate` / `grayscale` / `sepia` / `invert` / `blur` 映射到同义效果，`snow` / `confetti` / `sparkle` / `noise` 分别映射为 `snowflakes` / `confetti` / `draw_particles` / `add_noise`；无法映射的 CSS filter 片段保留为 `custom_filter`（不在效果目录中，仅用于旧数据），保存后统一写新的 `stack` 形态。

旧版本写入的 `v:1` 数据（矩形/箭头/文字）可正常读取并补齐默认样式，保存时升级为 v2；数据损坏或版本未知时按无工程数据打开，并提示原标注无法恢复，保存后以新的 v2 数据覆盖该 tEXt 块。

### 原图缓存

首次保存时把「未标注原图」单独缓存到：

```
data/storage/petal/siyuan-plugin-anno-mark/originals/<sha1>.png
```

再次打开时按元数据里的 `originalHash` 取回缓存并校验 SHA-1，用原图作底图重新合成背景与标注，因此效果与标注不会重复叠加。裁剪或调整尺寸会改动底图并置位 `baseDirty`，保存时按新底图重写缓存与哈希，再编辑时不会二次裁切；旋转与翻转作为效果记录在 `effects` 中，重开时只应用一次。缓存缺失或哈希不符时降级为以当前成品作底图并给出提示，此时不挂载旧标注与效果（避免二次旋转与重复叠加），按原件继续编辑，保存时重新写入缓存。

## 主题

所有界面颜色都通过 `--b3-theme-*` 映射变量（`--am-bg`、`--am-panel`、`--am-toolbar`、`--am-border`、`--am-ctl`、`--am-text`、`--am-text-2`、`--am-accent`、`--am-danger`）取值，深色/浅色主题自动跟随。色板、渐变预设与标注颜色属于内容色，保持固定值，不随主题变化。

## 已知限制

- 钉住与上传在思源环境中没有对应能力，按钮保持禁用。
- 噪点、彩纸、雪花、粒子等程序化效果由带种子的伪随机数生成，相同随机种子下结果固定。
- 只有 PNG 可以原地覆盖再编辑；JPEG / WebP 只能另存为 PNG 副本。
- 原图缓存不会自动清理，会占用与原图体积相近的磁盘空间；可手动删除 `originals/` 目录（删除后退化为以当前成品为底图）。
- 外链图片与 `data:` / `blob:` 图片不会出现「标注图片」右键项（无法定位到工作区内的 `assets/...` 文件）。
- 打印依赖浏览器弹窗；被拦截时编辑器内提示，已打开的预览窗口仍可使用。

## 与 ShareX.ImageEditor 的差异

- 边框/画框/窗口/阴影类效果（30 项）无论排在效果栈的哪一位，都会等全部像素效果执行完再运行，因此先加的模糊或色彩滤镜不会把边框一起处理；代价是这类效果的实际执行顺序与栈中显示顺序不完全一致。
- 效果栈里的像素实现只改写底图，标注始终绘制在效果结果之上，不会被模糊、扭曲或重新着色；裁剪、缩放、翻转与 90° 旋转属于画布几何操作，仍会同步变换标注坐标。
- 不提供任意角度的自由旋转：`rotate_custom_angle` 的角度按 90° 取整，元数据中的 `rotate` 只保存 0 / 90 / 180 / 270。
- C 级 19 项不重复实现，而是调用编辑器自己的裁剪、缩放、画布尺寸、翻转、旋转、背景与绘制工具；`draw_text`、`draw_shape`、`draw_line`、`draw_image` 等以标注工具的形式落地，不会进入像素栈。

## 安装

1. 安装依赖并构建：

   ```bash
   npm install
   npm run build
   ```

2. 把 `dist/` 目录**整个**复制到思源工作区的插件目录，目录名保持不变：

   ```
   <工作区>/data/plugins/siyuan-plugin-anno-mark/
   ```

3. 打开思源，在 `设置 → 集市 / 已安装插件` 中启用「AnnoMark 图片标注」，或重启思源。

`plugin.json` 的 `frontends` 为 `["desktop"]`，移动端不会注册菜单。

## 开发

### 目录结构

```
siyuan-plugin-anno-mark/
├─ src/
│  ├─ index.ts            # 插件生命周期、图片右键菜单、Dialog、保存分支、图片刷新
│  ├─ editor.ts           # 编辑器编排：状态、历史、指针/键盘、命令、效果栈与参数编辑、裁剪与文字输入
│  ├─ canvas.ts           # Scene 计算、背景/标注渲染、合成导出、命中检测
│  ├─ storage.ts          # PNG tEXt 读写、CRC32、v1/v2 元数据编解码、旧效果迁移、SHA-1、缓存路径
│  ├─ api.ts              # getFileBlob / putFile / insertBlock / showMessage 封装
│  ├─ asset-path.ts       # 图片地址归一化为 assets/...
│  ├─ types.ts            # Annotation 判别联合、BgState、EffectState、OPT_VIS、色板与预设
│  ├─ index.css           # --am-* 令牌映射、外壳与共享控件样式
│  ├─ types/siyuan.d.ts   # siyuan 模块的最小类型声明
│  ├─ effects/
│  │  ├─ types.ts         # 效果/参数/栈条目/边框 insets 类型
│  │  ├─ catalog.ts       # 232 项目录、分组、默认参数、C 级委托映射
│  │  ├─ engine.ts        # 有序效果栈执行、1600px 预览缩放、LRU 缓存
│  │  ├─ pixels.ts        # ImageData 读取、创建与像素辅助
│  │  ├─ rand.ts          # mulberry32 可复现随机数
│  │  ├─ data/
│  │  │  └─ effects.ts    # 232 项 id/分类/tier/参数快照（与测试 fixture 同步）
│  │  ├─ impl/
│  │  │  ├─ index.ts      # 213 项实现注册表与 30 项边框效果集合
│  │  │  ├─ adjustments.ts / manipulations.ts
│  │  │  ├─ drawings.ts
│  │  │  └─ filters-f1.ts / filters-f2.ts / filters-f3.ts / filters-f4.ts
│  │  └─ ops/
│  │     ├─ index.ts
│  │     ├─ color.ts / kernels.ts / warp.ts
│  │     └─ frames.ts / textures.ts / styles.ts
│  └─ ui/
│     ├─ shell.ts / shell.css                  # 浮动外壳、左右侧栏、画布区、图层
│     ├─ toolbar.ts / toolbar.css              # 文件按钮、21 工具、面板开关
│     ├─ options-bar.ts / options-bar.css      # 上下文属性条
│     ├─ popups.ts / popups.css                # 颜色/线宽/字体/阴影等弹层内容
│     ├─ popup.ts / popup.css                  # 锚定弹层定位与生命周期
│     ├─ background-panel.ts / background-panel.css
│     ├─ effects-panel.ts / effects-panel.css  # 4 分组目录、搜索、已应用栈列表
│     ├─ effect-param-popup.ts / effect-param-popup.css # 参数弹层与居中模态
│     ├─ bottom-bar.ts / bottom-bar.css        # 底部命令栏与缩放菜单
│     ├─ context-menu.ts / context-menu.css    # 右键菜单
│     ├─ toast.ts / toast.css                  # 单条提示
│     ├─ editor.css                            # 画布区、裁剪框、文字输入框
│     └─ icons.ts                              # 内联 SVG 图标（24×24，currentColor）
├─ i18n/                  # zh_CN.json / en_US.json，扁平点号键，键集合与顺序一致
├─ scripts/copy-static.mjs # 构建后复制 plugin.json、图标、预览图、README 与 i18n
├─ tests/
│  ├─ effects.test.ts      # 232 项目录、分组、参数、委托与旧数据迁移
│  ├─ effect-engine.test.ts # 效果栈签名/缓存键与颜色、卷积、变形算子
│  ├─ storage.test.ts      # PNG 元数据往返、CRC、v1 升级、SHA-1 等
│  └─ fixtures/sharex-effects.json # ShareX 3.x 效果目录快照
├─ vite.config.ts          # 库模式 + CJS，external: siyuan / process
└─ plugin.json
```

### 常用命令

```bash
npm run dev    # vite build --watch：持续重建 dist/index.js 与 index.css
npm test       # node --test "tests/*.test.ts"：效果目录、效果引擎与存储
npm run build  # vite build + 复制静态文件，产出可安装的 dist/
npx tsc -p .   # 仅类型检查（tsconfig 中 noEmit）
```

构建产物：

- `dist/index.js`：CommonJS 入口，`siyuan` 与 `process` 保持 external，由思源运行时提供。
- `dist/index.css`：全部编辑器样式（各 `src/ui/*.css` 由 Vite 合并）。
- `dist/plugin.json`、`dist/icon.png`、`dist/preview.png`、`dist/README.md`、`dist/i18n/`：由 `scripts/copy-static.mjs` 复制。
- `npm run dev` 只重建 JS/CSS，不会复制静态文件；改动 `plugin.json`、i18n 后需执行一次 `npm run build`。

## 许可与致谢

- 交互与视觉布局参考 ShareX.ImageEditor 原型，代码为本项目独立实现，未引入图标库或第三方图形库。
- 本仓库目前未附带 `LICENSE` 文件；如需对外分发，请自行补充许可协议并注明来源。
