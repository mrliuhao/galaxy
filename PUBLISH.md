# 发布到活页

> 只有 main 分支的内容允许发布。发布前先确认已 pull 到最新。

## 前提

- 活页连接器已连接（WorkBuddy 侧）。
- 一次性 `SPACE_TOKEN` 由用户在发布时提供；**不要写进仓库**。

## 步骤

1. 把 `index.html` 放到独立发布目录，目录里**只放这一份入口文件**：

   ```bash
   mkdir -p meditation-room-h5-livepage
   cp index.html meditation-room-h5-livepage/index.html
   ```

2. 确认 `index.html` 的 `<title>` 与分享卡标题一致（当前为「银河心事铺」）。

3. 用活页推送（通过 WorkBuddy 活页连接器，或 `space.mjs push`）：

   ```bash
   node space.mjs push meditation-room-h5-livepage \
     --token "$SPACE_TOKEN" \
     --proposal 01M7S46F9B55G9V70C3RXK6764 \
     --manifest meditation-room-h5-livepage-manifest.json
   ```

4. 发布后同步分享卡：

   ```json
   {
     "name": "银河心事铺",
     "share": {
       "title": "银河心事铺",
       "desc": "一间开在星河中央的房间。挑一个地方、一段声音，想安静的时候回来坐一会儿。"
     }
   }
   ```

5. 用 `get_page status` 核实线上版本，不要只靠 curl 抓源码比对（平台会注入 SDK，字节不同）。

## 已知事项

- 活页小程序外层转发按钮 `#spPush` 会盖住页面右下角，H5 内已预留 `--host-fab:52px`，此问题不要试图在 H5 里删按钮。
- manifest.json 里的标题是历史遗留，实际以 `update_page` 设置的分享卡为准。
