<p align="center"><img src="icon.svg" width="96" alt=""></p>

# 让你的大肥鱼可以自己主动学习歌曲

[qqbot-music](https://github.com/aa1805370178-dot/qqbot-music) 的 DeepSeek Harness（dsh）插件。装上以后，大肥鱼多两个工具：

- **`sing`**：用你给的音色唱歌。会唱就唱副歌（或整首），存成 WAV 并在本机放出来；不会就自己去学。没说唱哪首就从会唱的歌里随机挑。
- **`learn_song`**：主动去学一首歌——自己去 QQ 音乐定原唱、到 B 站找对得上的版本、分离人声和伴奏，几分钟后就会唱了。

零样本换声：只要一段 10–25 秒的干净录音当音色，不用训练；GTX 1650 Ti 4G 显卡也能跑。

> 插件本身不跑模型，只通过 HTTP 调 qqbot-music 的唱歌服务，所以**要先装好 qqbot-music**（换声、分离都在那边，需要 NVIDIA 显卡）。

## 安装

1. 按 [qqbot-music 的 README](https://github.com/aa1805370178-dot/qqbot-music#快速开始) 装好，确认 `python -m qqbot_music serve` 能起来。
2. 装插件，然后重启 dsh：

   ```sh
   dsh plugin --profile web add dsh-zeroshot-sing
   ```

   也可以在 dsh 的插件页「发现」里搜「大肥鱼学唱歌」。

## 配置

在你的 profile 覆盖层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）里写，没写的项用默认值：

```yaml
- id: qqbot-music
  config:
    url: http://127.0.0.1:8766          # 唱歌服务地址
    # 服务没开时自动拉起来；留空就要你自己先开服务
    startCommand: D:/xxx/seed-vc/env/Scripts/python.exe -m qqbot_music serve
    startCwd: D:/xxx/qqbot-music
    startSeconds: 120
    outputDir: ""                       # 唱好的 WAV 放哪；空 = ~/Music/qqbot-music
    play: true                          # 唱好后在本机放出来
    allowFull: true                     # 是否允许唱整首（整首要好几分钟）
    chorusTimeout: 600
    fullTimeout: 3600
```

本机播放：Windows 用系统自带的 `Media.SoundPlayer`，macOS 用 `afplay`，Linux 用 `paplay`。

## 用起来是什么样

```
你：给我唱一下周杰伦的晴天
大肥鱼：（调用 sing，一两分钟后）《晴天》副歌唱好了，正在播放，文件在 ~/Music/qqbot-music/晴天_副歌_….wav

你：去学一下田馥甄的小幸运
大肥鱼：（调用 learn_song）已经开始学了，要几分钟，学会后叫我唱就行。
```

## 开发

```sh
npm test    # 用假的唱歌服务测两个工具，不需要 dsh 和显卡
```

工具直接用原始 JSON Schema 注册，不依赖 `@deepseek-ai/dsh-tools`，所以不会被 dsh 的 peer 版本检查卡住。在 dsh 0.2.0-rc.2 上实测过：Qwen3-8B 能正确调用 `sing` 和 `learn_song`。

## 其他框架

- MaiBot：[qqbot-music-maibot](https://github.com/aa1805370178-dot/qqbot-music-maibot)
- AstrBot：[astrbot_plugin_zeroshot_sing](https://github.com/aa1805370178-dot/astrbot_plugin_zeroshot_sing)

## 许可证

GPL-3.0-or-later
