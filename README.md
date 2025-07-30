# Vue 3 S3大文件上传系统

一个基于Vue 3 + TypeScript + Vite构建的S3大文件上传前端系统，支持分片上传、断点续传、秒传等高级功能。
local-file-upload 对应Node后端仓库：[node-file-upload-server](https://github.com/xuzhiqiang0723/node-file-upload-server)
s3-file-upload 对应Java后端仓库：[java-s3-file-upload](https://github.com/xuzhiqiang0723/java-s3-file-upload)

## ✨ 功能特性

### 🚀 核心功能
- **分片上传**: 采用5MB分片大小，符合AWS S3最佳实践
- **断点续传**: 网络中断后可恢复上传进度，无需重新开始
- **秒传功能**: 相同文件哈希值实现瞬间上传
- **并发控制**: 支持多分片并发上传，提升传输效率
- **进度监控**: 实时显示上传进度、速度统计和剩余时间

### 🔒 安全特性
- **MD5校验**: 文件完整性双重验证
- **分片哈希**: 每个分片独立哈希验证
- **错误重试**: 自动重试机制，提高上传成功率

### 📊 用户体验
- **实时速度图表**: 可视化上传速度曲线
- **分片状态显示**: 直观显示每个分片的上传状态
- **步骤引导**: 清晰的操作步骤提示
- **响应式设计**: 支持移动端和桌面端

## 🛠️ 技术栈

- **前端框架**: Vue 3 (Composition API)
- **开发语言**: TypeScript
- **构建工具**: Vite 7.0
- **包管理器**: pnpm
- **文件处理**: spark-md5 (MD5计算)
- **存储服务**: Amazon S3

## 📦 项目结构

```
large-file-upload-front/
├── src/
│   ├── components/
│   │   └── file-upload/
│   │       ├── index.vue          # 主组件
│   │       └── use-s3-upload.ts   # S3上传逻辑Hook
│   ├── main.ts                    # 应用入口
│   └── App.vue                    # 根组件
├── public/
├── package.json
├── vite.config.ts
└── README.md
```

## 🚀 快速开始

### 环境要求
- Node.js >= 18.0.0
- pnpm >= 8.0.0

### 安装依赖
```bash
pnpm install
```

### 开发运行
```bash
pnpm dev
```

### 生产构建
```bash
pnpm build
```

### 预览构建结果
```bash
pnpm preview
```

## ⚙️ 配置说明

### S3上传配置
在 `src/components/file-upload/index.vue` 中配置S3上传参数：

```typescript
const {
  // ... 其他配置
} = useS3Upload({
  chunkSize: 5 * 1024 * 1024,              // 分片大小：5MB
  concurrent: 1,                            // 并发数：1个
  retryTimes: 3,                           // 重试次数：3次
  baseUrl: 'http://localhost:3000/api/s3/upload', // 后端API地址
  headers: {},                             // 请求头
  hashChunkSize: 1 * 1024 * 1024          // 哈希计算分片：1MB
})
```

### 后端API接口
系统需要对接以下后端API：

#### 1. 健康检查
```
GET /api/health
```

#### 2. 检查上传状态
```
POST /api/s3/upload/check
Content-Type: application/json

{
  "fileHash": "string",
  "fileName": "string", 
  "fileSize": number
}
```

#### 3. 初始化分片上传
```
POST /api/s3/upload/initialize
Content-Type: application/json

{
  "fileName": "string",
  "fileHash": "string",
  "fileSize": number,
  "chunkSize": number,
  "totalChunks": number
}
```

#### 4. 上传分片
```
POST /api/s3/upload/chunk
Content-Type: multipart/form-data

{
  "chunk": File,
  "chunkIndex": number,
  "partNumber": number,
  "fileHash": "string",
  "chunkHash": "string"
}
```

#### 5. 完成上传
```
POST /api/s3/upload/complete
Content-Type: application/json

{
  "fileHash": "string"
}
```

## 📋 使用流程

1. **选择文件**: 点击上传区域选择要上传的文件
2. **计算哈希**: 系统自动计算文件MD5哈希值
3. **检查状态**: 检查S3是否支持秒传或断点续传
4. **开始上传**: 
   - 秒传：文件已存在，瞬间完成
   - 断点续传：从上次中断位置继续
   - 正常上传：分片并发上传到S3
5. **监控进度**: 实时查看上传进度和网络状态
6. **完成下载**: 获取S3下载链接

## 🎯 核心Hook说明

### useS3Upload Hook
主要的上传逻辑封装在 `use-s3-upload.ts` 中：

```typescript
// 主要状态
const {
  isUploading,           // 是否正在上传
  isPaused,              // 是否已暂停  
  isCompleted,           // 是否已完成
  isCalculatingHash,     // 是否正在计算哈希
  isCheckingUpload,      // 是否正在检查上传状态
  isSecondTransfer,      // 是否为秒传
  currentFile,           // 当前文件
  fileHash,              // 文件哈希值
  chunks,                // 分片列表
  uploadProgress,        // 上传进度
  speedInfo,             // 速度信息
  
  // 主要方法
  startCalculateHash,    // 开始计算哈希
  startUpload,           // 开始上传
  pauseUpload,           // 暂停上传
  resumeUpload,          // 恢复上传
  cancelUpload,          // 取消上传
  reset                  // 重置状态
} = useS3Upload(options)
```

## 🔧 开发调试

启用调试模式可以查看详细的上传状态信息：

1. 点击页面底部的"显示S3调试信息"按钮
2. 查看实时的状态数据、分片信息等
3. 便于排查上传问题和性能优化

## 📈 性能优化

### 上传优化建议
- 使用5MB分片大小，符合S3多部分上传最佳实践
- 网络稳定时可适当增加并发数
- 大文件建议在稳定网络环境下上传
- 利用断点续传功能应对网络中断

### 系统限制
- 单文件最大支持：10GB
- S3理论最大支持：5TB
- 分片最小尺寸：5MB（符合S3要求）
- 最大分片数：10,000个（S3限制）

## 🏗️ 部署说明

### 构建生产版本
```bash
pnpm build
```

### 部署到静态服务器
将 `dist` 目录部署到任何静态文件服务器（如Nginx、Apache等）。

### 环境变量配置
可以通过环境变量配置后端API地址：
```bash
# .env.production
VITE_API_BASE_URL=https://your-api-domain.com
```

## 🤝 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开 Pull Request

## 📄 开源协议

本项目采用 MIT 协议 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🙋‍♂️ 问题反馈

如遇到问题或有功能建议，请在 [Issues](https://github.com/xuzhiqiang0723/large-file-upload-front/issues) 中反馈。

## 🔗 相关链接

- [Vue 3 文档](https://cn.vuejs.org/)
- [Vite 文档](https://cn.vitejs.dev/)
- [AWS S3 多部分上传](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [TypeScript 文档](https://www.typescriptlang.org/)
