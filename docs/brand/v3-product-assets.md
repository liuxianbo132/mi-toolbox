# V3.0 首批物品素材

`assets-preview` 的 23 个文件实际均为 1254 × 1254 PNG，均含真实 Alpha。全透明像素约占 31.8%–76.5%。联系表在浅灰背景上检查了相对体量、轮廓、边缘和辨识度，入选稿在缩略图中无明显残留背景。原图单张约 0.58–1.30 MB，因此 12 张入选稿均经裁切透明留白、等比缩放与压缩后接入。出图为 192 × 192，主体最长边 154 px，约 7.8–37.5 KB。

| 物品 | 入选文件 | 发布文件 |
| --- | --- | --- |
| 纯牛奶 | `牛奶.png` | `milk-carton.png` |
| 酸奶 | `酸奶.png` | `yogurt-cup.png` |
| 鸡蛋 | `鸡蛋.png` | `eggs.png` |
| 面包 | `切片白面包.png` | `bread-sliced.png` |
| 药瓶 | `药瓶.png` | `medicine-bottle.png` |
| 抽纸 | `抽纸.png` | `tissue-box.png` |
| 大米 | `大米2.png`，袋装和米碗在小图下均易辨识 | `rice.png` |
| 面条 | `面条1.png`，斜向形态和袋内线条清楚 | `noodles.png` |
| 食用油 | `油2.png`，金色油瓶加标签帮助区分 | `cooking-oil.png` |
| 猫罐头 | `猫罐头1.PNG`，猫脸和金属罐轮廓清楚 | `cat-wet-food.png` |
| 猫条 | `猫条2.png`，橙色单支与猫砂区分 | `cat-treat.png` |
| 猫砂 | `猫砂1.png`，有袋装、猫标识和砂铲 | `cat-litter.png` |

发布图位于 `assets/illustrations/v3/products/`，12 张合计 312,889 B。11 张未选变体为重复备选，当前无需重做。直接以原始体积入包的数量为 0。已确认小咪 IP 的 PNG 和原有场景引用沿用。 [后续素材清单](../../ASSETS-TODO.md)

微信开发者工具的首页、库存、物品详情、用药和存放位置的 WXML 与 WXSS 编译通过。使用演示数据核对了两张实际渲染截图，名称、别名、类别回退和资源尺寸由专项回归验证。 [首页](../screenshots/v3-runtime/01-home-products.jpg) · [库存](../screenshots/v3-runtime/02-inventory-products.jpg)
