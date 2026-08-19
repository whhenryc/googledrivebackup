# Drive Transfer — Google Drive 資料夾搬運工具（Web UI）

4 步驟嘅 web wizard：連結帳戶 → 揀來源資料夾 → 揀目標位置 → 執行搬運（即時進度）。

**原理**：全程用 Google Drive API 嘅 `files.copy`，喺 Google 伺服器內部直接複製檔案。無論係呢個 app 所在嘅主機，定係使用者部電腦，都唔會經手任何檔案內容——只有 API 指令來回。

只需要授權「接收檔案嗰個帳戶（B）」一次；來源帳戶（A）只需要將資料夾分享畀 B。

**斷點續傳**：每複製一個資料夾/檔案都即時記落 SQLite。如果搬運中途中斷（伺服器重啟、網路斷線等），重新打開頁面會見到「有未完成嘅搬運工作」，撳「繼續搬運」就會由中斷嗰度接住做，唔會重複複製。

---

## 1. 建立 Google Cloud OAuth 憑證

1. 去 [Google Cloud Console](https://console.cloud.google.com/) 開一個新專案
2. 「API 和服務」→「已啟用的 API 和服務」→ 啟用 **Google Drive API**
3. 「API 和服務」→「OAuth 同意畫面」：
   - 使用者類型選 **外部（External）**
   - 狀態設做「測試中（Testing）」就夠，唔使送審
   - 「測試使用者」加入你想用嚟接收檔案嗰個 Google 帳戶 email
4. 「憑證」→「建立憑證」→「OAuth 用戶端 ID」：
   - 應用程式類型：**網頁應用程式（Web application）**
   - 已授權的重新導向 URI：
     - 本地開發：`http://localhost:3000/auth/google/callback`
     - Railway 部署後：`https://你的網域/auth/google/callback`（部署完攞到網域先加返呢條，之後重新部署一次）
   - 建立後記低 **用戶端 ID** 同 **用戶端密鑰**

---

## 2. 本地執行

```bash
npm install
cp .env.example .env
# 編輯 .env，填返 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
npm start
```

打開 `http://localhost:3000`，跟住 4 個步驟做。

---

## 3. 部署到 Railway

同你平時工作流程一樣（GitHub → Railway）：

1. 呢個資料夾 push 上一個新嘅 GitHub repo（`.env` 已經喺 `.gitignore`，唔會上到 GitHub，密鑰安全）
2. Railway → New Project → Deploy from GitHub repo → 揀呢個 repo
3. Railway 會自動偵測 Node.js，用 `npm start` 啟動（`package.json` 已經設定好）
4. Settings → Variables，加入：
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`（用 Railway 分配到嘅網域，例如 `https://drive-transfer.up.railway.app/auth/google/callback`）
   - `SESSION_SECRET`（隨機長字串）
5. 部署完成攞到正式網域之後，返去 Google Cloud Console 個 OAuth 憑證，將呢個網域嘅 callback URI 加入「已授權的重新導向 URI」
6. 重新部署一次（或者 Railway 通常會自動重啟）即可使用

### ⚠️ 一定要加 Railway Volume（否則斷點續傳形同虛設）

Railway 個容器預設檔案系統係**暫存**嘅——每次重新部署都會清空，SQLite 檔案（`data/jobs.db`）都會跟住冇咗。要令斷點續傳喺重新部署後仍然有效，一定要掛一個 **Volume**：

1. Railway → 你個 service → **Settings** → **Volumes** → **Add Volume**
2. Mount path 填 `/data`
3. 加返一個環境變數：`DB_PATH=/data/jobs.db`
4. Redeploy 一次

如果唔加 Volume，工具本身照樣可以用，只不過「斷點續傳」淨係喺同一個容器生命週期內有效（例如程式短暫出錯自動保留進度），一旦 Railway 重新部署就會連 SQLite 一齊清空，跌返做要由頭嚟過。

---

## 使用流程

1. **連結帳戶** — 用接收檔案嗰個 Google 帳戶（B）登入授權
2. **來源資料夾** — 貼上資料夾連結或 ID（記得先喺 A 帳戶分享畀 B，Viewer 已足夠，並確認冇開啟「限制下載/複製」）
3. **目標位置** — 揀模式，再貼上 B 帳戶入面想存放嘅資料夾：
   - **完整複製**：每次都喺目標位置建立一個新資料夾（可選改名），適合一次性搬遷
   - **同步更新**：直接將貼上嘅資料夾當做同步目的地（唔會再包多一層），目的地已有嘅同名檔案只有嚟源修改時間較新先會覆寫，目的地獨有嘅檔案唔會被刪除
4. **執行搬運** — 按「開始搬運」，會先快速掃描一次來源資料夾（攞總數同總大小），跟住開始真正複製，右邊會顯示進度百分比、即時速度、預計完成時間，同埋逐項嘅資料夾/檔案 log，完成後有連結直接打開新資料夾

## 速度同預計完成時間點計出嚟

- **掃描階段**：開始複製之前，會先行一次來源資料夾樹（只讀 metadata，唔會落地內容），攞到總資料夾數、總檔案數、總大小（bytes）。呢個階段本身都要少少時間（幾千個檔案通常幾秒到幾十秒），會有獨立嘅「掃描緊…」提示。
- **掃描結果會快取**：掃描階段行過嘅每層 listing 結果會暫存喺記憶體，之後真正複製嗰陣直接攞嚟用，唔會對同一個資料夾再問 Google 多一次，慳返 API 用量。
- **可以選擇唔掃描**：Step 4 有個「掃描總大小」開關，預設開啟。如果你唔需要進度/速度資訊，或者想盡快開始複製（跳過掃描嗰段前置時間），可以關咗佢——會直接開始複製，只有逐項 log，冇進度條/ETA。
- **進度百分比**：已完成大小 ÷ 總大小。
- **即時速度**：用最近 20 秒嘅樣本計算（唔係由頭到尾嘅平均值），所以速度上落會反映緊真實網路/API 狀況，唔會因為一開始快/慢而長期偏差。
- **預計完成時間**：（總大小 − 已完成大小）÷ 即時速度，動態更新。
- **限制**：Google Docs / Sheets / Slides 呢啲原生格式冇實際 byte size（Google 唔會回傳 `size` 呢個欄位），會當 0 位元組計。如果一個資料夾入面全部都係呢類原生格式，進度條同 ETA 會唔準（因為分母總大小接近 0），呢種情況建議睇返「已完成」個 log 逐項進度就夠。
- 掃描結果（總量統計）會存落 SQLite，斷點續傳時唔使重新掃描一次（除非中斷嗰陣正正發生喺掃描階段）；但快取喺記憶體嘅逐層 listing 結果唔會跨重啟保留，resume 之後嘅複製階段會照舊直接問 Google（唔影響正確性，只係少咗快取帶嚟嘅慳位）。
- 同步模式嘅 ETA 係假設「全部都要處理」計出嚟，實際上好多已經最新嘅檔案會即時跳過，所以真實完成時間通常會比 ETA 顯示嘅快。

## 同步更新模式點解要留意

- **判斷依據**：目的地已有嘅檔案，會攞佢個 `modifiedTime` 同來源比較，來源較新先覆寫；一樣新或者來源較舊就會跳過（計入「已係最新」）。
- **覆寫嘅實際做法**：Google Drive API 冇「將 A 檔案內容寫入現有 B 檔案」呢個伺服器端操作，`files.copy` 一定會產生新嘅 file ID。所以覆寫實際上係：將目的地舊檔案移入垃圾桶（可以喺 Google Drive 垃圾桶度復原），然後複製一份新嘅落去、保留檔名。**呢個代表覆寫之後 file ID 會變**，如果你有連結直接指向舊檔案（例如分享咗個直接連結畀人），呢條連結會跟住原有檔案一齊入咗垃圾桶。
- **唔會處理刪除**：如果來源刪除咗某個檔案，目的地嗰邊唔會自動跟住刪除（單向、只加唔減，避免誤刪你目的地自己加落去嘅嘢）。
- **名稱比對係精確配對**：同名先會判斷做「同一個項目」，改咗名嘅檔案會當做新檔案處理（唔會覆寫，會另外複製一份）。
- 可以重複執行同一組來源/目的地，每次淨係處理有變更嘅部分，適合定期備份/同步用途。

---

## 大量資料（例如 500GB）要留意嘅事

- **搬運本身冇大小/時間上限**——`files.copy` 係伺服器端操作，唔受你網路頻寬限制。
- **目標帳戶儲存空間**要夠（Google Docs/Sheets/Slides 唔計入容量，其他檔案類型會實際佔用目標帳戶嘅儲存額度）。
- **Drive API 配額**：檔案量極多（例如幾萬個）有機會撞到 Google 嘅每分鐘/每日配額，程式已內建指數退避重試（429/500/503），撞到會自動放慢但唔會死。
- **斷點續傳**已經處理咗中途中斷嘅風險——見上面「⚠️ 一定要加 Railway Volume」。冇加 Volume 嘅話，重新部署就會令進度歸零。
- 大量細檔案（例如幾萬張相）遠比少量大檔（例如幾百個影片）耗時，因為每個檔案都係獨立一次 API call。

## 技術備註

- Session 用 `express-session` 內建記憶體儲存，適合單一使用者/單一 instance 使用。
- 搬運進度用 SQLite（`db.js`）逐項記錄（已建立嘅資料夾、已複製嘅檔案、已略過嘅捷徑），中斷後憑呢啲紀錄判斷邊啲做咗，達到斷點續傳。
- **`refresh_token` 會存喺 SQLite 入面**，用嚟喺伺服器重啟後唔使你重新登入都可以繼續個工作。呢個 token 等於長期存取你 Drive 嘅鎖匙，`data/` 資料夾已經加咗落 `.gitignore`，千祈唔好將個 db 檔案分享或者 commit 落 git。
- 進度更新用 Server-Sent Events（SSE），單向 stream，唔使另外裝 WebSocket library。
- Google Docs / Sheets / Slides 呢啲原生格式可以直接複製；捷徑（Shortcut）檔案會被跳過並喺記錄提示。
- Shared Drive（共用雲端硬碟）都支援，程式已加 `supportsAllDrives`。

## 檔案結構

```
drive-copy-web/
├── server.js          # Express 後端：OAuth、resolve、複製工作引擎（可續傳）、SSE
├── db.js               # SQLite 持久化：工作狀態、資料夾對照、已複製檔案紀錄
├── public/
│   ├── index.html      # wizard 畫面 + 未完成工作提示
│   ├── style.css        # 視覺設計
│   └── app.js            # 前端邏輯
├── package.json
├── .env.example
└── .gitignore
```
