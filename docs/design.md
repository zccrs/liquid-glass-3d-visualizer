# Liquid Glass 3D 可视化器 设计文档

## 目标

一个单文件 HTML 项目，用 Three.js 实现两个 3D 视图，帮助理解 `liquidglass.frag` 中的玻璃几何与折射参数。

## 范围

- 视图 A：玻璃边缘的**剖面光路图**（3D 空间中展示一条入射光线在玻璃表面 Snell 折射后命中背景的过程），标注 `θi`、`θt`、法线、`ior`。
- 视图 B：完整玻璃轮廓/形状的 **3D 实体模型**（圆角矩形 + squircle 剖面高度场），标注 `width`、`height`、`radius`、`bezelWidth`、`thickness`。
- 所有标注在 3D 场景内（引线 + sprite），侧栏同时提供参数滑条与文字说明。
- 界面语言：中文为主，参数名保留英文。

## 参数模型（与 shader 对齐）

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| width | 20–400 | 300 | 玻璃宽（像素） |
| height | 20–400 | 200 | 玻璃高（像素） |
| radius | 0–200 | 60 | 圆角半径 |
| bezelWidth | 2–60 | 60 | 边缘过渡带宽度（t 从 0→1 的像素数） |
| thickness | 10–200 | 50 | 玻璃基础厚度（剖面高度缩放） |
| ior | 1.0–3.0 | 1.5 | 折射率 |
| specular | 0–1 | 0 | 镜面高光 |
| tint | 0–0.4 | 0 | 白色染色 |
| refractionMaxTan | 0.1–8 | 2.75 | 几何斜率上限 |
| contentEdgePull | 0–1 | 0.5 | 唇边保留的拉拽比例 |
| contentRampEnd | 0–1 | 0.5 | 拉拽到达满值的 t |

## 视图 A：剖面光路图

### 数据来源

取玻璃右边缘中点的垂直剖面（沿 +X 方向），把 2D 剖面嵌入 3D 场景：

- 剖面曲线：`t ∈ [0,1]`，`s = 1−t`，`h(t) = (1−s⁴)^¼`
- 屏幕像素坐标：`x = −bezelWidth + t·bezelWidth`，`z = h(t)·thickness`（z 向上）
- 斜率：`dt/dx = 1/bezelWidth`，`dh/dt = s³·h/(1−s⁴)`，`tan θi_raw = dh/dx = (dh/dt)·(thickness/bezelWidth)`
- 截断：`tan θi = min(tan θi_raw, refractionMaxTan)`

### 光线

- 背景平面位于 `z = 0`（下方，用网格纹理代表 backdrop）
- 入射光方向固定：从右上方射向表面，方向与法线夹角即 `θi`（取 `atan(tan θi)`）
- 折射：`sin θt = sin θi / ior`，`tan θt` 决定出射方向
- 光路：入射点 → 表面 → 折射 → 命中背景平面（求交），命中点即 shader 中 `sampleBg` 的采样点
- 屏幕位移 `magG = H·contentRamp·max(tan θi − tan θt, 0)`，在剖面图上画一条从入射点到命中点的箭头，长度与 `magG` 成正比

### 标注

- 入射角 `θi`：在入射点画弧线 + 文字
- 折射角 `θt`：在表面点画弧线 + 文字
- 法线：虚线
- `ior`：文字标签，附在折射光线旁
- `bezelWidth`：剖面图上方水平尺寸线
- `thickness`：剖面图左侧垂直尺寸线（最大高度处）

## 视图 B：3D 玻璃实体模型

### 网格

- 参数化圆角矩形：中心区域 + 四边 + 四角，用极坐标采样（角区）+ 直线采样（边区）
- 高度场：`z(p) = h(t(p))·thickness`，`t(p)` 由 `getFieldT` 计算（与 shader 相同的 bezel 场逻辑，含 expanding-corners 分支）
- 侧面：从轮廓向下延伸一个固定厚度（视觉用），底部封闭
- 材质：半透明 + 环境反射，边缘可加线框辅助观察轮廓

### 标注

- `width`：X 方向总尺寸线
- `height`：Y 方向总尺寸线
- `radius`：在某个圆角处画半径引线 + 文字
- `bezelWidth`：沿边缘画一条过渡带宽度指示（双箭头）
- `thickness`：侧面垂直尺寸线

## 技术方案

- 单文件 `liquid-glass-3d.html`，Three.js 通过 CDN import map 引入
- 无构建步骤，浏览器直接打开
- UI：左侧 3D 视图，右侧参数面板（滑条 + 数值 + 说明文字）
- 两个视图可切换（Tab）或并排（宽屏）


## 视图 B：底部贴图折射

### 目标

视图 B 支持上传一张图片作为玻璃背后的固定内容。上传后，玻璃像 Treeland 中的 glass 一样覆盖在图片上：改变玻璃大小只改变玻璃窗口，不缩放图片；拖动玻璃会改变它在图片上的采样位置。

### UI

- 侧栏提供 `上传底部贴图` 区域。
- `<input type="file" accept="image/*">` 只接受图片。
- 未上传图片时保留当前可旋转 3D 玻璃几何视图。
- 上传图片后切换到正面预览模式：相机面向屏幕，禁用 3D 旋转，用鼠标拖动玻璃在图片上移动。
- 背景图片采用 contain 居中显示，图片可以比玻璃大。

### 场景结构

- `imageBackdrop`：固定背景图片平面，独立于玻璃尺寸。
- `refractedImageMesh`：与玻璃轮廓一致的折射采样层，采样固定背景图片坐标。
- `glassOffset`：玻璃相对图片中心的 2D 偏移，拖动时更新。
- 现有参数滑条保持可用；图片模式下尺寸线和部分 3D 标注可隐藏，避免遮挡预览。

### 折射模型

- 片元坐标先转换为背景图片坐标：`bgCoord = glassOffset + localGlassCoord`。
- 用 rounded-rect SDF 近似 2D 外法线方向。
- 用 `t`、`profilePower`、`thickness/bezelWidth` 计算表面斜率。
- 用 `ior` 和 Snell 关系计算 `tanθt`。
- 用 shader 公式近似位移：
  `magG = H·contentRamp·max(slopeMag−tanθt, 0)`。
- `contentRamp = mix(contentEdgePull, 1, smoothstep(0, contentRampEnd, t))`。
- `refractionMaxTan` 截断 `slopeMag`。
- 最终采样：`sampleCoord = bgCoord + n2·magG`，再按固定 `imagePlaneSize` 转成 UV。

### 验证

- 浏览器测试生成一张临时 PNG 并上传。
- 上传后检查 `window.__viz.textureLoaded === true`、`dragEnabled === true`、`OrbitControls.enabled === false`。
- 改 `width/height` 后检查 `imagePlaneSize` 不变，证明图片不随玻璃缩放。
- 模拟拖动后检查 `glassOffset` 改变。
- 截图确认上传图片固定在背景上，玻璃正面覆盖其上，边缘区域出现折射拉伸。

## 文件

- `docs/superpowers/specs/2026-07-23-liquid-glass-visualizer-design.md` — 本文档
- `liquid-glass-3d.html` — 实现
