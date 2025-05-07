## 2025/5/7 11:46
已完成字幕优化：在 [`parseSubtitleFile()`](content.js) 返回前插入 optimizeSubtitles，对 result 进行处理。逻辑为：若字幕片段中文字符少于8，则合并到相邻较短字幕，并同步调整时间戳，最后重新编号。涉及修改行号：1010-1013。


## 2025/5/7 11:39
优化字幕对象，实现短字幕自动合并：
1. 添加 countChineseChars() 函数用于计算中文字符数量
2. 添加 mergeSubtitles() 函数用于合并字幕对象
3. 修改 parseSubtitleFile() 函数添加字幕合并逻辑

主要功能：
- 检测字幕中文字符数量少于8的片段
- 将短字幕与相邻较短的字幕进行合并
- 自动处理合并后的时间戳

修改位置：content.js 中 parseSubtitleFile 函数及其相关辅助函数
