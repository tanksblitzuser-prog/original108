# 108 — Online Card Game

## Ishga tushirish
- Node.js 18 yoki yangiroq versiya kerak.
- `npm install`
- `npm start`

Render sozlamalari:
- Root Directory: `oyin-108` (agar repository ichida loyiha shu papkada tursa; agar `package.json` repository ildizida bo'lsa, bo'sh qoldiring)
- Build Command: `npm install`
- Start Command: `node server.js`

## Media
`public/assets/` ichida intro videosi (`108.mp4`) va o'yin ovozlari mavjud. Intro 10 soniyadan keyin Skip tugmasini ko'rsatadi. Skip bosilgach, shu o'yinchida stol ochiladi, lekin server barcha faol o'yinchilar `introDone` yubormaguncha yurishlarni qabul qilmaydi. Skip ovozi bosilgandan 3 soniya keyin faqat shu brauzerda chalinadi.

O'yinning karta qoidalari `engine.js` ichida va bu yangilanishda o'zgartirilmagan.
