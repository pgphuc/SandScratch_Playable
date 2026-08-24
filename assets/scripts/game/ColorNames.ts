// Bảng TÊN MÀU -> HEX của 72 màu lọ. BAKE từ ir/materials.json: mỗi material
// `Color/Materials/3DObjectColor_WithTex/<N>. <Name>.mat` có _BaseMap trỏ tới texture ĐẶT TÊN BẰNG HEX
// (vd "10. Orange2.mat" -> GameAssets/72_Box_Color/FFA03D.png). Đó là nguồn duy nhất trong IR cho map này —
// ColorDefinitionSO.cs có logic nhưng GIÁ TRỊ nằm ở asset chưa extract.
//
// ⚠ Số tiền tố trong tên material ("21. ...") KHÔNG phải colorId. colorId đến từ pixelLevelData.indices; cách
// nối 2 bên là so HEX, xem colorIdOfJarName(). Kiểm chứng trên Release Level 0001:
//   colorId 21 -> #FF9900 -> Yellow5 · 65 -> #F2EDE6 -> Neutral1 · 72 -> #2E2722 -> Neutral8

/** Tên màu -> RGB 24-bit. Chỉ RGB: alpha của lọ do vật liệu quyết định, không nằm trong tên. */
export const COLOR_NAME_HEX: Readonly<Record<string, number>> = {
  "Blue1": 0x2979ff,
  "Blue2": 0x5ca6ff,
  "Blue3": 0x84c3ff,
  "Blue4": 0x1e88e5,
  "Blue5": 0x1976d2,
  "Blue6": 0x1565c0,
  "Blue7": 0x0d47a1,
  "Blue8": 0x08306b,
  "Cyan1": 0x00e5ff,
  "Cyan2": 0x4ff0ff,
  "Cyan3": 0x7ff5ff,
  "Cyan4": 0x00c9d6,
  "Cyan5": 0x00a8b8,
  "Cyan6": 0x008c9b,
  "Cyan7": 0x00737f,
  "Cyan8": 0x00565f,
  "Green1": 0x2ee66a,
  "Green2": 0x66eb8d,
  "Green3": 0x8bf0a8,
  "Green4": 0x22c55e,
  "Green5": 0x16a34a,
  "Green6": 0x0e8f39,
  "Green7": 0x0a732e,
  "Green8": 0x075b25,
  "Neutral1": 0xf2ede6,
  "Neutral2": 0xe4dccf,
  "Neutral3": 0xc9beae,
  "Neutral4": 0xad9f8d,
  "Neutral5": 0x8e8172,
  "Neutral6": 0x6d6154,
  "Neutral7": 0x4b423a,
  "Neutral8": 0x2e2722,
  "Orange1": 0xff8b00,
  "Orange2": 0xffa03d,
  "Orange3": 0xffb45c,
  "Orange4": 0xff6a1a,
  "Orange5": 0xff4d00,
  "Orange6": 0xe63a00,
  "Orange7": 0xc62800,
  "Orange8": 0xa31d00,
  "Pink1": 0xff5bae,
  "Pink2": 0xff7cc9,
  "Pink3": 0xffa6da,
  "Pink4": 0xff33a1,
  "Pink5": 0xe6007e,
  "Pink6": 0xc4006b,
  "Pink7": 0x9c0056,
  "Pink8": 0x7a0043,
  "Purple1": 0xb266ff,
  "Purple2": 0xc18bff,
  "Purple3": 0xd1b3ff,
  "Purple4": 0x9b4dff,
  "Purple5": 0x7c3aed,
  "Purple6": 0x6730d3,
  "Purple7": 0x512da8,
  "Purple8": 0x3b1e78,
  "Red1": 0xff4a4a,
  "Red2": 0xff6a6a,
  "Red3": 0xff8080,
  "Red4": 0xff3d6a,
  "Red5": 0xff0050,
  "Red6": 0xe60036,
  "Red7": 0xc7002b,
  "Red8": 0xa3001e,
  "Yellow1": 0xffd600,
  "Yellow2": 0xffe066,
  "Yellow3": 0xffca3d,
  "Yellow4": 0xffb300,
  "Yellow5": 0xff9900,
  "Yellow6": 0xe68300,
  "Yellow7": 0xcc6d00,
  "Yellow8": 0xa35200,
};

/** RGB 24-bit của 1 tên màu, hoặc -1 nếu tên không có trong bảng (KHÔNG bịa màu thay thế). */
export function hexOfColorName(name: string): number {
  const v = COLOR_NAME_HEX[name];
  return v === undefined ? -1 : v;
}
