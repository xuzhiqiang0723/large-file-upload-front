<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import { useS3Upload } from './use-s3-upload';

// 使用S3上传Hook
const {
  isUploading,
  isPaused,
  isCompleted,
  isCalculatingHash,
  isCheckingUpload,
  isInitializing,
  isSecondTransfer,
  currentFile,
  fileHash,
  chunks,
  uploadProgress,
  hashProgress,
  resumeInfo,
  uploadedChunks,
  remainingChunks,
  totalChunks,
  speedInfo,
  networkStats,
  formatSpeed,
  calculateRemainingTime,
  startCalculateHash,
  startUpload,
  pauseUpload,
  resumeUpload,
  cancelUpload,
  reset,
} = useS3Upload({
  chunkSize: 5 * 1024 * 1024, // 5MB分片，适合S3
  concurrent: 3, // 3个并发
  retryTimes: 3,
  baseUrl: 'http://localhost:3000/api/s3/upload',
  headers: {},
  hashChunkSize: 1 * 1024 * 1024, // 1MB for hash calculation
});

const fileInput = ref<HTMLInputElement>();
const uploadResult = ref<string>('');
const errorMessage = ref<string>('');
const showDebug = ref(false);
const uploadStartTime = ref<number>(0);
const lastUploadedBytes = ref<number>(0);
const lastTimeStamp = ref<number>(0);

// 调试信息
const debugInfo = computed(() => ({
  isUploading: isUploading.value,
  isPaused: isPaused.value,
  isCompleted: isCompleted.value,
  isCalculatingHash: isCalculatingHash.value,
  isCheckingUpload: isCheckingUpload.value,
  isInitializing: isInitializing.value,
  isSecondTransfer: isSecondTransfer.value,
  currentFile: currentFile.value
    ? {
        name: currentFile.value.name,
        size: currentFile.value.size,
        type: currentFile.value.type,
      }
    : null,
  fileHash: fileHash.value,
  hashProgress,
  resumeInfo: resumeInfo.value,
  chunksCount: chunks.value.length,
  uploadedChunksCount: uploadedChunks.value.length,
  progress: uploadProgress,
  errorMessage: errorMessage.value,
  timestamp: new Date().toLocaleString(),
}));

// 计算上传总时长
const uploadDuration = computed(() => {
  if (uploadStartTime.value && isCompleted.value) {
    const duration = Date.now() - uploadStartTime.value;
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}小时${minutes % 60}分${seconds % 60}秒`;
    } else if (minutes > 0) {
      return `${minutes}分${seconds % 60}秒`;
    } else {
      return `${seconds}秒`;
    }
  }
  return '';
});

// 获取分片状态图标
const getChunkStatusIcon = (chunk: any) => {
  if (chunk.uploaded) {
    return chunk.uploaded && resumeInfo.value ? '🔄' : '✓';
  } else if (chunk.progress > 0) {
    return '↑';
  } else if (chunk.retryCount > 0) {
    return '⚠';
  } else {
    return '○';
  }
};

// 获取分片提示信息
const getChunkTooltip = (chunk: any) => {
  const status = chunk.uploaded
    ? '已完成'
    : chunk.progress > 0
      ? '上传中'
      : '等待中';
  const resumeText = chunk.uploaded && resumeInfo.value ? ' (断点续传)' : '';
  const retryText = chunk.retryCount > 0 ? ` (重试${chunk.retryCount}次)` : '';
  return `S3分片 ${chunk.partNumber}: ${status}${resumeText}${retryText}`;
};

// 获取步骤样式类
const getStepClass = (stepNumber: number) => {
  switch (stepNumber) {
    case 1: {
      return {
        active: !currentFile.value,
        completed: currentFile.value,
      };
    }
    case 2: {
      return {
        active:
          currentFile.value &&
          !fileHash.value &&
          !isCalculatingHash.value &&
          !isCheckingUpload.value,
        completed: fileHash.value,
        processing: isCalculatingHash.value || isCheckingUpload.value,
      };
    }
    case 3: {
      return {
        active:
          fileHash.value &&
          !isUploading.value &&
          !isCompleted.value &&
          !isSecondTransfer.value,
        completed: isCompleted.value || isSecondTransfer.value,
        processing: isUploading.value,
      };
    }
    default: {
      return {};
    }
  }
};

// 获取步骤图标
const getStepIcon = (stepNumber: number) => {
  switch (stepNumber) {
    case 1: {
      return currentFile.value ? '✅' : '👆';
    }
    case 2: {
      return isCalculatingHash.value || isCheckingUpload.value
        ? '⏳'
        : fileHash.value
          ? '✅'
          : '🔢';
    }
    case 3: {
      return isCompleted.value || isSecondTransfer.value
        ? '✅'
        : isUploading.value
          ? '⏳'
          : '🚀';
    }
    default: {
      return '○';
    }
  }
};

// 监听文件变化
watch(currentFile, (newFile) => {
  console.log('文件选择变化:', newFile);
  if (newFile) {
    uploadResult.value = '';
    errorMessage.value = '';
  }
});

// 监听上传开始
watch(isUploading, (uploading) => {
  if (uploading && !uploadStartTime.value) {
    uploadStartTime.value = Date.now();
    lastUploadedBytes.value = 0;
    lastTimeStamp.value = Date.now();
  }
});

// 监听哈希计算状态
watch(isCalculatingHash, (calculating) => {
  console.log('MD5计算状态:', calculating ? '开始' : '完成');
});

// 监听文件哈希变化
watch(fileHash, (newHash) => {
  console.log('文件哈希计算完成:', newHash);
});

// 监听秒传状态
watch(isSecondTransfer, (secondTransfer) => {
  if (secondTransfer) {
    console.log('⚡ S3秒传成功！');
  }
});

// 触发文件选择
const triggerFileSelect = () => {
  if (isCalculatingHash.value || isUploading.value || isCheckingUpload.value)
    return;
  fileInput.value?.click();
};

// 处理文件选择
const handleFileSelect = async (event: Event) => {
  try {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];

    console.log('选择的文件:', file);

    if (!file) {
      console.log('没有选择文件');
      return;
    }

    // 文件大小检查
    if (file.size === 0) {
      errorMessage.value = '文件大小为0，请选择有效文件';
      return;
    }

    if (file.size > 10 * 1024 * 1024 * 1024) {
      // 10GB 限制
      errorMessage.value = '文件过大，请选择小于10GB的文件';
      return;
    }

    // 重置状态
    reset();
    uploadResult.value = '';
    errorMessage.value = '';
    uploadStartTime.value = 0;

    // 手动设置文件到 currentFile
    currentFile.value = file;

    console.log('文件设置成功:', {
      name: file.name,
      size: `${(file.size / 1024 / 1024).toFixed(2)}MB`,
      type: file.type,
    });

    // 强制更新视图
    await nextTick();
  } catch (error) {
    console.error('文件选择处理失败:', error);
    errorMessage.value =
      error instanceof Error ? error.message : '文件选择失败';
  }
};

// 处理计算哈希
const handleCalculateHash = async () => {
  try {
    console.log('开始计算S3文件哈希');
    errorMessage.value = '';

    await startCalculateHash();

    console.log('S3文件哈希计算完成');
  } catch (error) {
    console.error('计算哈希失败:', error);
    errorMessage.value =
      error instanceof Error ? error.message : '计算哈希失败';
  }
};

// 清除文件
const clearFile = () => {
  reset();
  uploadResult.value = '';
  errorMessage.value = '';
  uploadStartTime.value = 0;
  if (fileInput.value) {
    fileInput.value.value = '';
  }
};

// 开始上传
const handleStartUpload = async () => {
  if (!currentFile.value) {
    errorMessage.value = '请先选择文件';
    return;
  }

  if (!fileHash.value) {
    errorMessage.value = '请先计算文件哈希值';
    return;
  }

  try {
    console.log('开始S3上传文件:', currentFile.value.name);
    errorMessage.value = '';
    uploadStartTime.value = Date.now();

    const result = await startUpload();

    if (result) {
      uploadResult.value = result;
      console.log('S3上传成功:', result);
    }
  } catch (error) {
    console.error('S3上传失败:', error);
    errorMessage.value = error instanceof Error ? error.message : 'S3上传失败';
  }
};

// 暂停上传
const handlePauseUpload = async () => {
  try {
    console.log('暂停S3上传');
    await pauseUpload();
  } catch (error) {
    console.error('暂停S3上传失败:', error);
    errorMessage.value =
      error instanceof Error ? error.message : '暂停S3上传失败';
  }
};
const handleResumeUpload = async () => {
  try {
    console.log('恢复S3上传');
    errorMessage.value = '';

    const result = await resumeUpload();

    if (result) {
      uploadResult.value = result;
      console.log('恢复S3上传成功:', result);
    }
  } catch (error) {
    console.error('恢复S3上传失败:', error);
    errorMessage.value =
      error instanceof Error ? error.message : '恢复S3上传失败';
  }
};

// 重试上传
const handleRetryUpload = async () => {
  try {
    console.log('重试S3上传');
    errorMessage.value = '';
    uploadStartTime.value = Date.now();

    const result = await startUpload();

    if (result) {
      uploadResult.value = result;
      console.log('重试S3上传成功:', result);
    }
  } catch (error) {
    console.error('重试S3上传失败:', error);
    errorMessage.value =
      error instanceof Error ? error.message : '重试S3上传失败';
  }
};

// 取消上传
const handleCancelUpload = () => {
  cancelUpload();
  clearFile();
  console.log('S3上传已取消');
};

// 开始新的上传
const handleNewUpload = () => {
  clearFile();
  console.log('准备上传新文件到S3');
};

// 下载文件
const downloadFile = () => {
  if (uploadResult.value) {
    window.open(uploadResult.value, '_blank');
  }
};

// 复制下载链接
const copyDownloadLink = async () => {
  if (uploadResult.value) {
    try {
      await navigator.clipboard.writeText(uploadResult.value);
      alert('下载链接已复制到剪贴板');
    } catch (error) {
      console.error('复制失败:', error);
      // 降级方案
      const textArea = document.createElement('textarea');
      textArea.value = uploadResult.value;
      document.body.append(textArea);
      textArea.select();
      document.execCommand('copy');
      textArea.remove();
      alert('下载链接已复制到剪贴板');
    }
  }
};

// 清除错误
const clearError = () => {
  errorMessage.value = '';
};

// 切换调试信息
const toggleDebug = () => {
  showDebug.value = !showDebug.value;
};

// 格式化文件大小
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
};

// 测试函数
const testConnection = async () => {
  try {
    const response = await fetch('http://localhost:3000/api/health');
    const data = await response.json();
    console.log('服务器连接测试:', data);
    return data;
  } catch (error) {
    console.error('服务器连接失败:', error);
    errorMessage.value = '无法连接到服务器，请确保服务器已启动';
    throw error;
  }
};

// 新增：速度图表相关
const speedChart = ref<HTMLCanvasElement>();
let chartAnimationId: null | number = null;

// 格式化上传时间
const formatUploadTime = () => {
  if (networkStats.startTime === 0) return '0秒';

  const elapsed = Date.now() - networkStats.startTime;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}小时${minutes % 60}分钟`;
  } else if (minutes > 0) {
    return `${minutes}分钟${seconds % 60}秒`;
  } else {
    return `${seconds}秒`;
  }
};

// 绘制速度图表
const drawSpeedChart = () => {
  if (!speedChart.value || networkStats.speedHistory.length === 0) return;

  const canvas = speedChart.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  // 清空画布
  ctx.clearRect(0, 0, width, height);

  // 计算最大速度用于缩放
  const maxSpeed = Math.max(...networkStats.speedHistory, speedInfo.average);
  if (maxSpeed === 0) return;

  // 绘制网格
  ctx.strokeStyle = '#e1e4e8';
  ctx.lineWidth = 1;

  // 水平网格线
  for (let i = 0; i <= 4; i++) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // 垂直网格线
  for (let i = 0; i <= 10; i++) {
    const x = (width / 10) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // 绘制平均速度线
  ctx.strokeStyle = '#28a745';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  const avgY = height - (speedInfo.average / maxSpeed) * height;
  ctx.beginPath();
  ctx.moveTo(0, avgY);
  ctx.lineTo(width, avgY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 绘制速度曲线
  if (networkStats.speedHistory.length > 1) {
    ctx.strokeStyle = '#0366d6';
    ctx.lineWidth = 2;
    ctx.beginPath();

    networkStats.speedHistory.forEach((speed, index) => {
      const x = (index / (networkStats.speedHistory.length - 1)) * width;
      const y = height - (speed / maxSpeed) * height;

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
  }

  // 绘制当前速度点
  if (networkStats.speedHistory.length > 0) {
    ctx.fillStyle = '#dc3545';
    const lastSpeed =
      networkStats.speedHistory[networkStats.speedHistory.length - 1];
    const x = width;
    const y = height - ((lastSpeed || 0) / maxSpeed) * height;

    ctx.beginPath();
    ctx.arc(x - 5, y, 4, 0, 2 * Math.PI);
    ctx.fill();
  }
};

// 监听速度变化并更新图表
watch(
  () => networkStats.speedHistory.length,
  () => {
    if (chartAnimationId) {
      cancelAnimationFrame(chartAnimationId);
    }
    chartAnimationId = requestAnimationFrame(drawSpeedChart);
  },
);

// 组件卸载时清理
onUnmounted(() => {
  if (chartAnimationId) {
    cancelAnimationFrame(chartAnimationId);
  }
});

// 组件挂载时测试服务器连接
onMounted(() => {
  testConnection().catch(() => {
    // 连接失败的处理已在 testConnection 中完成
  });
});
</script>

<template>
  <div class="upload-container">
    <!-- S3存储标识 -->
    <div class="storage-badge">
      <h3>☁️ S3对象存储 - 大文件上传</h3>
      <p>使用Amazon S3多部分上传技术，支持大文件稳定上传</p>
    </div>

    <!-- 检查上传状态进度 -->
    <div v-if="isCheckingUpload" class="check-progress">
      <h4>🔍 正在检查S3文件状态...</h4>
      <div class="loading-spinner"></div>
      <p class="check-tip">检查S3是否支持秒传或断点续传...</p>
    </div>

    <!-- 初始化进度 -->
    <div v-if="isInitializing" class="check-progress">
      <h4>🚀 正在初始化S3分片上传...</h4>
      <div class="loading-spinner"></div>
      <p class="check-tip">创建S3多部分上传会话...</p>
    </div>

    <!-- 秒传成功提示 -->
    <div v-if="isSecondTransfer" class="second-transfer-success">
      <h4>⚡ S3秒传成功！</h4>
      <p>检测到S3已存在相同文件，无需重复上传</p>
      <div class="second-transfer-info">
        <p><strong>文件名:</strong> {{ currentFile?.name }}</p>
        <p>
          <strong>文件大小:</strong>
          {{ currentFile ? formatFileSize(currentFile.size) : '' }}
        </p>
        <p><strong>文件哈希:</strong> {{ fileHash }}</p>
        <p><strong>存储位置:</strong> Amazon S3</p>
        <p><strong>节省时间:</strong> 瞬间完成上传</p>
      </div>
    </div>

    <!-- 断点续传信息 -->
    <div v-if="resumeInfo && !isSecondTransfer" class="resume-info">
      <h4>🔄 发现S3断点续传</h4>
      <p>检测到该文件之前的S3上传记录，可以从断点继续上传</p>
      <div class="resume-details">
        <p>
          <strong>已上传分片:</strong> {{ resumeInfo.uploadedCount }} /
          {{ resumeInfo.totalChunks }}
        </p>
        <p><strong>上传进度:</strong> {{ resumeInfo.progress }}%</p>
        <div class="resume-progress-bar">
          <div
            class="resume-progress-fill"
            :style="{ width: `${resumeInfo.progress}%` }"
          ></div>
        </div>
        <p class="resume-tip">您可以直接继续上传剩余部分到S3</p>
      </div>
    </div>

    <!-- MD5 计算进度 -->
    <div v-if="isCalculatingHash" class="hash-progress">
      <h4>🔢 正在计算文件哈希值...</h4>
      <div class="progress-bar">
        <div
          class="progress-fill hash-fill"
          :style="{ width: `${hashProgress.percentage}%` }"
        ></div>
      </div>
      <div class="progress-info">
        <span>{{ hashProgress.percentage }}%</span>
        <span>
          {{ formatFileSize(hashProgress.loaded) }} /
          {{ formatFileSize(hashProgress.total) }}
        </span>
      </div>
      <p class="hash-tip">大文件需要更长时间计算，请耐心等待...</p>
    </div>

    <div
      class="upload-area"
      @click="triggerFileSelect"
      :class="{
        disabled:
          isCalculatingHash ||
          isUploading ||
          isCheckingUpload ||
          isInitializing,
      }"
    >
      <input
        ref="fileInput"
        type="file"
        @change="handleFileSelect"
        :disabled="
          isCalculatingHash || isUploading || isCheckingUpload || isInitializing
        "
        class="file-input"
        style="display: none"
      />

      <div v-if="!currentFile" class="upload-placeholder">
        <div class="upload-icon">📁</div>
        <p>点击选择要上传的文件</p>
        <p class="upload-hint">支持S3大文件上传、断点续传、秒传功能</p>
      </div>

      <div v-else class="file-info">
        <div class="file-icon">📄</div>
        <h3>{{ currentFile.name }}</h3>
        <p>大小: {{ formatFileSize(currentFile.size) }}</p>
        <p>类型: {{ currentFile.type || '未知' }}</p>
        <p>存储: Amazon S3</p>

        <!-- 哈希状态显示 -->
        <div class="hash-status">
          <p v-if="fileHash" class="hash-complete">✅ MD5: {{ fileHash }}</p>
          <p v-else-if="isCalculatingHash" class="calculating">
            🔢 正在计算MD5... {{ hashProgress.percentage }}%
          </p>
          <p v-else-if="isCheckingUpload" class="checking">
            🔍 正在检查S3文件状态...
          </p>
          <p v-else-if="isInitializing" class="checking">
            🚀 正在初始化S3上传...
          </p>
          <p v-else class="hash-pending">⏳ 需要计算文件哈希值</p>
        </div>

        <button
          @click.stop="clearFile"
          class="clear-btn"
          :disabled="
            isCalculatingHash ||
            isUploading ||
            isCheckingUpload ||
            isInitializing
          "
        >
          {{
            isCalculatingHash ||
            isUploading ||
            isCheckingUpload ||
            isInitializing
              ? '处理中...'
              : '清除文件'
          }}
        </button>
      </div>
    </div>

    <!-- 操作按钮组 -->
    <div class="action-controls">
      <!-- 计算哈希按钮 -->
      <div
        v-if="
          currentFile &&
          !fileHash &&
          !isCalculatingHash &&
          !isCheckingUpload &&
          !isInitializing
        "
        class="hash-controls"
      >
        <button
          @click="handleCalculateHash"
          class="btn btn-info btn-large"
          :disabled="isUploading"
        >
          🔢 计算文件哈希值
        </button>
        <p class="hash-description">
          计算文件的MD5哈希值，检查S3是否支持秒传或断点续传
        </p>
      </div>

      <!-- 上传控制按钮 -->
      <div v-if="fileHash && !isSecondTransfer" class="upload-controls">
        <button
          @click="handleStartUpload"
          :disabled="
            !currentFile ||
            isUploading ||
            !fileHash ||
            isCalculatingHash ||
            isCheckingUpload ||
            isInitializing
          "
          class="btn btn-primary btn-large"
        >
          {{
            resumeInfo
              ? '🔄 继续S3上传'
              : isUploading
                ? 'S3上传中...'
                : '☁️ 开始S3上传'
          }}
        </button>

        <button
          v-if="isUploading && !isPaused"
          @click="handlePauseUpload"
          class="btn btn-warning"
        >
          ⏸️ 暂停
        </button>

        <button
          v-if="isPaused"
          @click="handleResumeUpload"
          class="btn btn-success"
        >
          ▶️ 恢复
        </button>

        <button
          @click="handleCancelUpload"
          :disabled="!currentFile"
          class="btn btn-danger"
        >
          ❌ 取消
        </button>
      </div>

      <!-- 秒传成功后的操作 -->
      <div v-if="isSecondTransfer" class="second-transfer-controls">
        <button @click="downloadFile" class="btn btn-success btn-large">
          📥 下载文件
        </button>
        <button @click="handleNewUpload" class="btn btn-outline">
          📁 上传新文件
        </button>
      </div>
    </div>

    <!-- 上传进度 -->
    <div
      v-if="
        currentFile &&
        fileHash &&
        !isCalculatingHash &&
        !isCheckingUpload &&
        !isInitializing &&
        !isSecondTransfer
      "
      class="progress-section"
    >
      <div class="overall-progress">
        <h4>S3总体进度</h4>
        <div class="progress-bar">
          <div
            class="progress-fill"
            :style="{ width: `${uploadProgress.percentage}%` }"
          ></div>
        </div>
        <div class="progress-info">
          <span>{{ uploadProgress.percentage }}%</span>
          <span>
            {{ formatFileSize(uploadProgress.loaded) }} /
            {{ formatFileSize(uploadProgress.total) }}
          </span>
        </div>

        <!-- 网络速度信息 -->
        <div v-if="isUploading" class="speed-stats">
          <div class="speed-row">
            <div class="speed-item">
              <span class="speed-label">当前速度:</span>
              <span class="speed-value current">{{
                formatSpeed(speedInfo.current)
              }}</span>
            </div>
            <div class="speed-item">
              <span class="speed-label">平均速度:</span>
              <span class="speed-value average">
                {{ formatSpeed(speedInfo.average) }}
              </span>
            </div>
            <div class="speed-item">
              <span class="speed-label">峰值速度:</span>
              <span class="speed-value peak">
                {{ formatSpeed(speedInfo.peak) }}
              </span>
            </div>
          </div>
          <div class="time-info">
            <span class="time-item">
              剩余时间: {{ calculateRemainingTime() }}
            </span>
            <span class="time-item">已用时间: {{ formatUploadTime() }}</span>
          </div>
        </div>
      </div>

      <!-- 网络速度图表 -->
      <div
        v-if="isUploading && networkStats.speedHistory.length > 0"
        class="speed-chart"
      >
        <h4>S3上传速度曲线</h4>
        <div class="chart-container">
          <canvas ref="speedChart" width="400" height="100"></canvas>
        </div>
        <div class="chart-legend">
          <span class="legend-item">
            <span class="legend-color current"></span>
            实时速度
          </span>
          <span class="legend-item">
            <span class="legend-color average"></span>
            平均速度
          </span>
        </div>
      </div>

      <!-- S3分片进度详情 -->
      <div v-if="chunks.length > 0" class="chunks-progress">
        <h4>S3分片进度 ({{ uploadedChunks.length }} / {{ totalChunks }})</h4>
        <div class="chunks-stats">
          <span class="stat-item">✅ 已完成: {{ uploadedChunks.length }}</span>
          <span class="stat-item">⏳ 剩余: {{ remainingChunks.length }}</span>
          <span class="stat-item">
            🔄 断点续传: {{ resumeInfo ? resumeInfo.uploadedCount : 0 }}
          </span>
          <span class="stat-item"> 📦 分片大小: 5MB (S3推荐) </span>
        </div>
        <div class="chunks-grid">
          <div
            v-for="chunk in chunks.slice(0, 50)"
            :key="chunk.index"
            class="chunk-item"
            :class="{
              uploaded: chunk.uploaded,
              uploading: chunk.progress > 0 && chunk.progress < 100,
              error: chunk.retryCount > 0,
              resumed: chunk.uploaded && resumeInfo,
            }"
            :title="getChunkTooltip(chunk)"
          >
            <span class="chunk-index">{{ chunk.partNumber }}</span>
            <div class="chunk-progress">
              <div
                class="chunk-progress-bar"
                :style="{ width: `${chunk.progress}%` }"
              ></div>
            </div>
            <span class="chunk-status">
              {{ getChunkStatusIcon(chunk) }}
            </span>
          </div>
        </div>
        <p v-if="chunks.length > 50" class="chunks-note">
          显示前50个S3分片，总共{{ chunks.length }}个分片
        </p>
      </div>
    </div>

    <!-- 继续上面的模板部分 -->

    <!-- 上传结果 -->
    <div v-if="uploadResult && !isSecondTransfer" class="upload-result">
      <h4>✅ S3上传完成</h4>
      <div class="result-info">
        <p><strong>文件名:</strong> {{ currentFile?.name }}</p>
        <p>
          <strong>文件大小:</strong>
          {{ currentFile ? formatFileSize(currentFile.size) : '' }}
        </p>
        <p><strong>文件哈希:</strong> {{ fileHash }}</p>
        <p><strong>存储位置:</strong> Amazon S3</p>
        <p><strong>上传时间:</strong> {{ uploadDuration }}</p>
        <p>
          <strong>下载链接:</strong>
          <a :href="uploadResult" target="_blank">{{ uploadResult }}</a>
        </p>
      </div>
      <div class="result-actions">
        <button @click="downloadFile" class="btn btn-success">
          📥 下载文件
        </button>
        <button @click="copyDownloadLink" class="btn btn-outline">
          📋 复制链接
        </button>
        <button @click="handleNewUpload" class="btn btn-outline">
          📁 上传新文件
        </button>
      </div>
    </div>

    <!-- 秒传结果 -->
    <div v-if="uploadResult && isSecondTransfer" class="second-transfer-result">
      <h4>⚡ S3秒传完成</h4>
      <div class="result-info">
        <p><strong>文件名:</strong> {{ currentFile?.name }}</p>
        <p>
          <strong>文件大小:</strong>
          {{ currentFile ? formatFileSize(currentFile.size) : '' }}
        </p>
        <p><strong>文件哈希:</strong> {{ fileHash }}</p>
        <p><strong>存储位置:</strong> Amazon S3</p>
        <p><strong>完成时间:</strong> 瞬间完成</p>
        <p>
          <strong>下载链接:</strong>
          <a :href="uploadResult" target="_blank">{{ uploadResult }}</a>
        </p>
      </div>
      <div class="result-actions">
        <button @click="downloadFile" class="btn btn-success">
          📥 下载文件
        </button>
        <button @click="copyDownloadLink" class="btn btn-outline">
          📋 复制链接
        </button>
        <button @click="handleNewUpload" class="btn btn-outline">
          📁 上传新文件
        </button>
      </div>
    </div>

    <!-- 错误信息 -->
    <div v-if="errorMessage" class="error-message">
      <h4>❌ S3操作失败</h4>
      <p>{{ errorMessage }}</p>
      <div class="error-actions">
        <button @click="clearError" class="btn btn-outline">清除错误</button>
        <button
          v-if="fileHash && !isSecondTransfer"
          @click="handleRetryUpload"
          class="btn btn-primary"
        >
          🔄 重试S3上传
        </button>
      </div>
    </div>

    <!-- 操作步骤说明 -->
    <div class="steps-guide">
      <h4>📋 S3上传步骤</h4>
      <ol>
        <li :class="getStepClass(1)">
          <span class="step-icon">{{ getStepIcon(1) }}</span>
          选择要上传的文件
        </li>
        <li :class="getStepClass(2)">
          <span class="step-icon">{{ getStepIcon(2) }}</span>
          计算文件哈希值并检查S3状态
        </li>
        <li :class="getStepClass(3)">
          <span class="step-icon">{{ getStepIcon(3) }}</span>
          {{
            isSecondTransfer
              ? 'S3秒传完成'
              : resumeInfo
                ? 'S3断点续传'
                : '开始S3分片上传'
          }}
        </li>
      </ol>
    </div>

    <!-- S3功能特性说明 -->
    <div class="features-info">
      <h4>✨ S3存储特性</h4>
      <div class="features-grid">
        <div class="feature-item">
          <div class="feature-icon">⚡</div>
          <h5>秒传功能</h5>
          <p>S3相同文件瞬间完成上传</p>
        </div>
        <div class="feature-item">
          <div class="feature-icon">🔄</div>
          <h5>断点续传</h5>
          <p>S3多部分上传支持断点恢复</p>
        </div>
        <div class="feature-item">
          <div class="feature-icon">📦</div>
          <h5>分片上传</h5>
          <p>5MB分片，适合S3大文件处理</p>
        </div>
        <div class="feature-item">
          <div class="feature-icon">☁️</div>
          <h5>云端存储</h5>
          <p>AWS S3高可用、无限容量</p>
        </div>
        <div class="feature-item">
          <div class="feature-icon">🔒</div>
          <h5>完整性校验</h5>
          <p>MD5哈希+ETag双重校验</p>
        </div>
        <div class="feature-item">
          <div class="feature-icon">🚀</div>
          <h5>并发上传</h5>
          <p>3个分片并发，提升速度</p>
        </div>
      </div>
    </div>

    <!-- S3性能提示 -->
    <div class="performance-tips">
      <h4>💡 S3上传优化建议</h4>
      <ul>
        <li>使用5MB分片大小，符合S3最佳实践</li>
        <li>S3多部分上传支持最大5TB文件</li>
        <li>相同文件哈希可实现S3秒传</li>
        <li>网络中断后可恢复S3上传会话</li>
        <li>建议在稳定网络环境下上传超大文件</li>
        <li>S3提供99.999999999%的数据持久性</li>
        <li>支持跨区域复制和版本控制</li>
      </ul>
    </div>

    <!-- S3调试信息 -->
    <div v-if="showDebug" class="debug-info">
      <h4>🔧 S3调试信息</h4>
      <pre>{{ debugInfo }}</pre>
      <button @click="toggleDebug" class="btn btn-outline">隐藏调试</button>
    </div>

    <button v-else @click="toggleDebug" class="debug-toggle">
      显示S3调试信息
    </button>
  </div>
</template>

<style scoped>
.upload-container {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* S3存储标识 */
.storage-badge {
  margin-bottom: 24px;
  padding: 20px;
  background: linear-gradient(135deg, #e3f2fd, #f0f4ff);
  border: 2px solid #2196f3;
  border-radius: 12px;
  text-align: center;
  box-shadow: 0 4px 12px rgba(33, 150, 243, 0.2);
}

.storage-badge h3 {
  margin: 0 0 8px 0;
  color: #1976d2;
  font-size: 20px;
  font-weight: 600;
}

.storage-badge p {
  margin: 0;
  color: #1976d2;
  font-size: 14px;
  opacity: 0.8;
}

/* 检查进度样式 */
.check-progress {
  margin-bottom: 24px;
  padding: 20px;
  background: linear-gradient(135deg, #e8f4fd, #f3e5f5);
  border: 1px solid #2196f3;
  border-radius: 8px;
  text-align: center;
}

.check-progress h4 {
  margin: 0 0 16px 0;
  color: #1976d2;
  font-size: 16px;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #e3f2fd;
  border-top: 4px solid #2196f3;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 16px;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.check-tip {
  margin: 0;
  font-size: 14px;
  color: #5e35b1;
  font-style: italic;
}

/* 秒传成功样式 */
.second-transfer-success {
  margin-bottom: 24px;
  padding: 24px;
  background: linear-gradient(135deg, #e8f5e8, #f1f8e9);
  border: 2px solid #4caf50;
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(76, 175, 80, 0.2);
}

.second-transfer-success h4 {
  margin: 0 0 16px 0;
  color: #2e7d32;
  font-size: 20px;
  text-align: center;
}

.second-transfer-info {
  background: rgba(255, 255, 255, 0.8);
  padding: 16px;
  border-radius: 8px;
  margin-top: 16px;
}

.second-transfer-info p {
  margin: 8px 0;
  color: #2e7d32;
  font-size: 14px;
}

.second-transfer-info strong {
  color: #1b5e20;
}

/* 断点续传信息样式 */
.resume-info {
  margin-bottom: 24px;
  padding: 20px;
  background: linear-gradient(135deg, #fff3e0, #fce4ec);
  border: 1px solid #ff9800;
  border-radius: 8px;
}

.resume-info h4 {
  margin: 0 0 12px 0;
  color: #e65100;
  font-size: 16px;
}

.resume-details {
  background: rgba(255, 255, 255, 0.7);
  padding: 12px;
  border-radius: 6px;
  margin-top: 12px;
}

.resume-details p {
  margin: 6px 0;
  color: #bf360c;
  font-size: 14px;
}

.resume-progress-bar {
  width: 100%;
  height: 8px;
  background: #ffcc02;
  border-radius: 4px;
  overflow: hidden;
  margin: 8px 0;
}

.resume-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #ff9800, #f57c00);
  transition: width 0.3s ease;
  border-radius: 4px;
}

.resume-tip {
  font-size: 12px;
  color: #e65100;
  font-style: italic;
  margin-top: 8px;
}

/* 哈希进度样式 */
.hash-progress {
  margin-bottom: 24px;
  padding: 20px;
  background: linear-gradient(135deg, #e3f2fd, #f3e5f5);
  border: 1px solid #2196f3;
  border-radius: 8px;
}

.hash-progress h4 {
  margin: 0 0 16px 0;
  color: #1976d2;
  font-size: 16px;
}

.hash-fill {
  background: linear-gradient(90deg, #2196f3, #9c27b0) !important;
}

.hash-tip {
  margin-top: 12px;
  font-size: 12px;
  color: #5e35b1;
  text-align: center;
  font-style: italic;
}

/* 上传区域样式 */
.upload-area {
  border: 3px dashed #e1e5e9;
  border-radius: 12px;
  padding: 40px;
  text-align: center;
  margin-bottom: 20px;
  cursor: pointer;
  transition: all 0.3s ease;
  background: #fafbfc;
}

.upload-area:hover:not(.disabled) {
  border-color: #2196f3;
  background: #f6f8fa;
}

.upload-area.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.upload-placeholder {
  color: #586069;
}

.upload-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.upload-hint {
  font-size: 14px;
  color: #6a737d;
  margin-top: 8px;
}

.file-info {
  position: relative;
}

.file-icon {
  font-size: 32px;
  margin-bottom: 12px;
}

.file-info h3 {
  margin: 0 0 10px 0;
  color: #24292e;
  font-size: 18px;
  word-break: break-word;
}

.file-info p {
  margin: 5px 0;
  color: #586069;
  font-size: 14px;
}

.hash-status {
  margin: 12px 0;
  padding: 8px;
  background: #f6f8fa;
  border-radius: 6px;
}

.hash-complete {
  color: #2e7d32 !important;
  font-weight: 500;
}

.calculating {
  color: #1976d2 !important;
  font-style: italic;
}

.checking {
  color: #9c27b0 !important;
  font-style: italic;
}

.hash-pending {
  color: #f57c00 !important;
  font-style: italic;
}

.clear-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  background: #dc3545;
  color: white;
  border: none;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.clear-btn:hover:not(:disabled) {
  background: #c82333;
}

.clear-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 操作控制区域 */
.action-controls {
  margin-bottom: 24px;
}

.hash-controls {
  text-align: center;
  margin-bottom: 20px;
  padding: 20px;
  background: linear-gradient(135deg, #fff3e0, #fce4ec);
  border-radius: 8px;
  border: 1px solid #ff9800;
}

.hash-description {
  margin-top: 12px;
  font-size: 14px;
  color: #e65100;
  font-style: italic;
}

.upload-controls,
.second-transfer-controls {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}

/* 按钮样式 */
.btn {
  padding: 12px 24px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  transition: all 0.2s ease;
  min-width: 100px;
}

.btn-large {
  padding: 16px 32px;
  font-size: 16px;
  min-width: 200px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none !important;
}

.btn:not(:disabled):hover {
  transform: translateY(-1px);
}

.btn-primary {
  background: linear-gradient(135deg, #2196f3, #1976d2);
  color: white;
  box-shadow: 0 2px 4px rgba(33, 150, 243, 0.2);
}

.btn-primary:not(:disabled):hover {
  background: linear-gradient(135deg, #1976d2, #1565c0);
  box-shadow: 0 4px 8px rgba(33, 150, 243, 0.3);
}

.btn-info {
  background: linear-gradient(135deg, #ff9800, #f57c00);
  color: white;
  box-shadow: 0 2px 4px rgba(255, 152, 0, 0.2);
}

.btn-info:not(:disabled):hover {
  background: linear-gradient(135deg, #f57c00, #ef6c00);
  box-shadow: 0 4px 8px rgba(255, 152, 0, 0.3);
}

.btn-warning {
  background: linear-gradient(135deg, #ffc107, #ffb300);
  color: #212529;
  box-shadow: 0 2px 4px rgba(255, 193, 7, 0.2);
}

.btn-success {
  background: linear-gradient(135deg, #28a745, #20c997);
  color: white;
  box-shadow: 0 2px 4px rgba(40, 167, 69, 0.2);
}

.btn-danger {
  background: linear-gradient(135deg, #dc3545, #c82333);
  color: white;
  box-shadow: 0 2px 4px rgba(220, 53, 69, 0.2);
}

.btn-outline {
  background: white;
  color: #2196f3;
  border: 1px solid #2196f3;
}

.btn-outline:hover {
  background: #2196f3;
  color: white;
}

/* 步骤指南 */
.steps-guide {
  margin-bottom: 24px;
  padding: 20px;
  background: #f8f9fa;
  border-radius: 8px;
  border-left: 4px solid #2196f3;
}

.steps-guide h4 {
  margin: 0 0 16px 0;
  color: #2196f3;
  font-size: 16px;
}

.steps-guide ol {
  margin: 0;
  padding-left: 0;
  list-style: none;
}

.steps-guide li {
  display: flex;
  align-items: center;
  padding: 8px 0;
  font-size: 14px;
  color: #6c757d;
  transition: all 0.2s ease;
}

.steps-guide li.active {
  color: #2196f3;
  font-weight: 600;
}

.steps-guide li.completed {
  color: #28a745;
  font-weight: 500;
}

.steps-guide li.processing {
  color: #ffc107;
  font-weight: 600;
}

.step-icon {
  margin-right: 12px;
  font-size: 16px;
  width: 20px;
  text-align: center;
}

/* 功能特性 */
.features-info {
  margin-bottom: 24px;
  padding: 20px;
  background: #f8f9fa;
  border-radius: 8px;
}

.features-info h4 {
  margin: 0 0 16px 0;
  color: #495057;
  font-size: 16px;
  text-align: center;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.feature-item {
  text-align: center;
  padding: 16px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.feature-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.feature-item h5 {
  margin: 8px 0 4px 0;
  color: #495057;
  font-size: 14px;
}

.feature-item p {
  margin: 0;
  color: #6c757d;
  font-size: 12px;
}

/* 进度样式 */
.progress-section {
  margin-bottom: 24px;
}

.overall-progress {
  margin-bottom: 24px;
  padding: 20px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.overall-progress h4 {
  margin: 0 0 16px 0;
  color: #24292e;
  font-size: 16px;
}

.progress-bar {
  width: 100%;
  height: 24px;
  background: #f1f3f4;
  border-radius: 12px;
  overflow: hidden;
  margin: 12px 0;
  position: relative;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #2196f3, #28a745);
  transition: width 0.3s ease;
  border-radius: 12px;
  position: relative;
}

.progress-fill::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.3),
    transparent
  );
  animation: shimmer 2s infinite;
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

.progress-info {
  display: flex;
  justify-content: space-between;
  font-size: 14px;
  color: #586069;
  font-weight: 500;
}

/* 网络速度统计样式 */
.speed-stats {
  margin-top: 16px;
  padding: 12px;
  background: #f8f9fa;
  border-radius: 6px;
  border: 1px solid #e1e4e8;
}

.speed-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-wrap: wrap;
  gap: 8px;
}

.speed-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  min-width: 100px;
}

.speed-label {
  font-size: 12px;
  color: #6a737d;
  margin-bottom: 2px;
}

.speed-value {
  font-size: 14px;
  font-weight: bold;
}

.speed-value.current {
  color: #2196f3;
}

.speed-value.average {
  color: #28a745;
}

.speed-value.peak {
  color: #dc3545;
}

.time-info {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #6a737d;
  border-top: 1px solid #e1e4e8;
  padding-top: 8px;
}

.time-item {
  flex: 1;
  text-align: center;
}

/* 速度图表样式 */
.speed-chart {
  margin-top: 24px;
  padding: 20px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.speed-chart h4 {
  margin: 0 0 16px 0;
  color: #24292e;
  font-size: 16px;
}

.chart-container {
  border: 1px solid #e1e4e8;
  border-radius: 4px;
  padding: 8px;
  background: #fafbfc;
}

.chart-legend {
  display: flex;
  justify-content: center;
  gap: 24px;
  margin-top: 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  font-size: 12px;
  color: #6a737d;
}

.legend-color {
  width: 12px;
  height: 3px;
  margin-right: 6px;
  border-radius: 2px;
}

.legend-color.current {
  background: #2196f3;
}

.legend-color.average {
  background: #28a745;
}

.chunks-progress {
  padding: 20px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.chunks-progress h4 {
  margin: 0 0 16px 0;
  color: #24292e;
  font-size: 16px;
}

.chunks-stats {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.stat-item {
  font-size: 12px;
  color: #6a737d;
  background: #f6f8fa;
  padding: 4px 8px;
  border-radius: 4px;
}

.chunks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.chunk-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px;
  border: 1px solid #e1e4e8;
  border-radius: 6px;
  background: #fafbfc;
  transition: all 0.2s ease;
  font-size: 12px;
}

.chunk-item.uploaded {
  background: #dcffe4;
  border-color: #34d058;
  color: #0d422b;
}

.chunk-item.resumed {
  background: #fff3cd;
  border-color: #ffc107;
  color: #856404;
}

.chunk-item.uploading {
  background: #fff8dc;
  border-color: #f9c513;
  animation: pulse 1.5s infinite;
}

.chunk-item.error {
  background: #ffe6e6;
  border-color: #f85149;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

.chunk-index {
  font-weight: 600;
  margin-bottom: 4px;
  color: #24292e;
}

.chunk-progress {
  width: 100%;
  height: 3px;
  background: #e1e4e8;
  border-radius: 2px;
  margin-bottom: 4px;
  overflow: hidden;
}

.chunk-progress-bar {
  height: 100%;
  background: #2196f3;
  transition: width 0.3s ease;
  border-radius: 2px;
}

.chunk-status {
  font-size: 14px;
  font-weight: bold;
}

.chunks-note {
  margin-top: 12px;
  font-size: 12px;
  color: #6a737d;
  text-align: center;
}

/* 结果样式 */
.upload-result,
.second-transfer-result {
  padding: 20px;
  background: linear-gradient(135deg, #dcffe4, #f0fff4);
  border: 1px solid #34d058;
  border-radius: 8px;
  margin-bottom: 20px;
}

.upload-result h4,
.second-transfer-result h4 {
  margin: 0 0 16px 0;
  color: #0d422b;
  font-size: 16px;
}

.result-info p {
  margin: 8px 0;
  font-size: 14px;
  color: #0d422b;
}

.result-info strong {
  color: #155724;
}

.result-info a {
  color: #2196f3;
  word-break: break-all;
  text-decoration: none;
}

.result-info a:hover {
  text-decoration: underline;
}

.result-actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.error-message {
  padding: 20px;
  background: linear-gradient(135deg, #ffe6e6, #fff5f5);
  border: 1px solid #f85149;
  border-radius: 8px;
  color: #86181d;
  margin-bottom: 20px;
}

.error-message h4 {
  margin: 0 0 12px 0;
  font-size: 16px;
}

.error-actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

/* 性能提示 */
.performance-tips {
  margin-top: 24px;
  padding: 16px;
  background: #f8f9fa;
  border-left: 4px solid #17a2b8;
  border-radius: 4px;
}

.performance-tips h4 {
  margin: 0 0 12px 0;
  color: #17a2b8;
  font-size: 14px;
}

.performance-tips ul {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: #6c757d;
}

.performance-tips li {
  margin-bottom: 4px;
}

/* 调试信息 */
.debug-info {
  padding: 20px;
  background: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 8px;
  margin-bottom: 20px;
}

.debug-info h4 {
  margin: 0 0 12px 0;
  color: #24292e;
  font-size: 16px;
}

.debug-info pre {
  background: #ffffff;
  padding: 12px;
  border-radius: 4px;
  border: 1px solid #e1e4e8;
  overflow-x: auto;
  font-size: 12px;
  color: #24292e;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.debug-toggle {
  padding: 8px 16px;
  background: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 4px;
  color: #586069;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
}

.debug-toggle:hover {
  background: #e1e4e8;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .upload-container {
    padding: 16px;
  }

  .storage-badge {
    padding: 16px;
  }

  .storage-badge h3 {
    font-size: 18px;
  }

  .upload-area {
    padding: 24px 16px;
  }

  .upload-controls,
  .second-transfer-controls,
  .result-actions,
  .error-actions {
    justify-content: center;
  }

  .btn {
    flex: 1;
    min-width: auto;
  }

  .btn-large {
    padding: 12px 20px;
    font-size: 14px;
    min-width: 150px;
  }

  .features-grid {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }

  .chunks-grid {
    grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
    gap: 6px;
  }

  .chunk-item {
    padding: 6px;
    font-size: 11px;
  }

  .chunks-stats {
    flex-direction: column;
    gap: 8px;
  }

  .speed-row {
    flex-direction: column;
    gap: 4px;
  }

  .speed-item {
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
  }

  .speed-label {
    margin-bottom: 0;
  }

  .time-info {
    flex-direction: column;
    gap: 4px;
  }

  .time-item {
    text-align: left;
  }
}
</style>
