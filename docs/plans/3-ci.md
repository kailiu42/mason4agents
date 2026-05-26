现在讨论如何为本项目增加Github CI，构建各种平台的cli binary，并自动发布到npm registry上。

## 要支持的平台

### OS支持

- Linux
- macOS
- Windows （不确定，需要调研mason registry）是否提供Windows bianry

## 硬件平台支持

- x86_64
- arm64

## CI任务

需要生成.github下的ci配置文件，自动化完成以下任务：

- 构建以上目标OS和平台组合的cli binary
- 自动化发布插件到npm registry

触发条件：

- 新的commit：仅构建但不发布
- 新的tag：构建且发布

## 还需要调研确定的

- mason的windows支持情况
- npm包发布最佳实践：cli binary不小，如果合并到一个大包里面发布会造成下载太大而且很多都是浪费的。npm是否支持按架构上传不同的子包，下载时只下载客户端对应的平台版本？如果不支持，调研网络上的建议，看看最佳实践是什么。
