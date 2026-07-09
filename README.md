# ルート走破時間シミュレータ

GPX ルートを読み込み、**地図・標高プロファイル・区間ごとの到達時刻**を推定するサイクリング用プランナー。
サーバー不要の**完全静的サイト**（HTML/CSS/JS のみ）。すべてブラウザ内で動作し、設定はローカルに保存されます。

## 主な機能

- GPX 読み込み → 地図（Leaflet）＋標高プロファイル表示
- 走行時間の推定（Strava 実走校正 × FTP 物理計算のブレンド）
- 信号停止・滞在ポイントを加味した到達時刻／サマリ
- 主要クライムの自動検出と VAM 表示
- スタート/ゴール＋一定間隔の経過時間マーカー（地図・標高図）
- Light / Cyber の 2 テーマ切替
- 状態の保存（ユーザー設定は共通、開始時刻・滞在・信号はルート単位）

## ローカルで動かす

クローンして `index.html` をブラウザで開くだけ（地図タイルとフォントの取得にネット接続が必要）。
```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>
# 例: 簡易サーバ
python3 -m http.server 8000   # → http://localhost:8000
```

## 公開（GitHub Pages・無料・CI/CD 付き）

1. GitHub で新規リポジトリを作成し、このフォルダをそのまま push（下記手順）。
2. リポジトリ **Settings → Pages → Build and deployment → Source を「GitHub Actions」** に設定。
3. 以降 `main` へ push するたび `.github/workflows/deploy.yml` が自動でビルド無しデプロイ。
4. 数十秒後、`https://<you>.github.io/<repo>/` で公開されます。

```bash
git init
git add -A
git commit -m "init: ルート走破時間シミュレータ"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 構成

```
index.html          … 画面
css/                … styles.css（レイアウト）＋ theme.css（テーマトークン）
js/                 … app / state / route / fit / import / models / schedule / map / chart
.github/workflows/  … deploy.yml（GitHub Pages 自動デプロイ）
DESIGN.md / VALIDATION.md … 設計・検証メモ
```

## クレジット / ライセンス

- 地図: © OpenStreetMap contributors ／ OpenTopoMap ／ Esri World Imagery
- 地図ライブラリ: Leaflet
- フォント: Google Fonts (Space Grotesk / Chakra Petch / DM Mono / Noto Sans JP)
- 本体コード: MIT License（`LICENSE` 参照）

v
> 注意: 地図タイルは各提供元の利用規約の範囲でご利用ください。大規模アクセスが見込まれる場合は、タイル提供元の商用/専用プラン（MapTiler 等）への切り替えを検討してください。
