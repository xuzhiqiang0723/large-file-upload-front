/* eslint-disable unicorn/prefer-add-event-listener */
/* eslint-disable unicorn/prefer-blob-reading-methods */
import { computed, reactive, ref } from 'vue';

import SparkMD5 from 'spark-md5';

interface S3ChunkInfo {
  index: number;
  partNumber: number;
  start: number;
  end: number;
  blob: Blob;
  uploaded: boolean;
  progress: number;
  retryCount: number;
  etag?: string;
  uploadStartTime?: number;
  uploadEndTime?: number;
  chunkHash?: string; // 添加分片哈希
}

interface S3UploadOptions {
  chunkSize?: number;
  concurrent?: number;
  retryTimes?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  hashChunkSize?: number;
}

interface S3UploadSession {
  sessionId: string;
  uploadId: string;
  objectName: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  uploadedParts?: number;
  progress?: number;
  parts?: Array<{ etag: string; partNumber: number }>;
}

interface S3UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

interface S3SpeedInfo {
  current: number;
  average: number;
  peak: number;
  lastUpdate: number;
}

interface S3NetworkStats {
  uploadedBytes: number;
  totalBytes: number;
  startTime: number;
  lastMeasureTime: number;
  lastMeasureBytes: number;
  speedHistory: number[];
}

interface S3CheckUploadResponse {
  success: boolean;
  fileExists: boolean;
  isComplete: boolean;
  message: string;
  url?: string;
  session?: S3UploadSession;
}

export function useS3Upload(options: S3UploadOptions = {}) {
  const {
    chunkSize = 5 * 1024 * 1024, // S3推荐5MB分片
    concurrent = 3,
    retryTimes = 3,
    baseUrl = '/api/s3/upload',
    headers = {},
    hashChunkSize = 2 * 1024 * 1024,
  } = options;

  // 响应式状态
  const isUploading = ref(false);
  const isPaused = ref(false);
  const isCompleted = ref(false);
  const isCalculatingHash = ref(false);
  const isCheckingUpload = ref(false);
  const isInitializing = ref(false);
  const currentFile = ref<File | null>(null);
  const fileHash = ref('');
  const chunks = ref<S3ChunkInfo[]>([]);
  const uploadSession = ref<null | S3UploadSession>(null);

  const uploadProgress = reactive<S3UploadProgress>({
    loaded: 0,
    total: 0,
    percentage: 0,
  });

  const hashProgress = reactive({
    loaded: 0,
    total: 0,
    percentage: 0,
  });

  const speedInfo = reactive<S3SpeedInfo>({
    current: 0,
    average: 0,
    peak: 0,
    lastUpdate: 0,
  });

  const networkStats = reactive<S3NetworkStats>({
    uploadedBytes: 0,
    totalBytes: 0,
    startTime: 0,
    lastMeasureTime: 0,
    lastMeasureBytes: 0,
    speedHistory: [],
  });

  const isSecondTransfer = ref(false);
  const resumeInfo = ref<any>(null);

  // 计算属性
  const uploadedChunks = computed(() =>
    chunks.value.filter((chunk) => chunk.uploaded),
  );

  const remainingChunks = computed(() =>
    chunks.value.filter((chunk) => !chunk.uploaded),
  );

  const totalChunks = computed(() => chunks.value.length);

  const uploadedSize = computed(() =>
    uploadedChunks.value.reduce(
      (sum, chunk) => sum + (chunk.end - chunk.start),
      0,
    ),
  );

  // 工具函数
  const formatSpeed = (bytesPerSecond: number): string => {
    if (bytesPerSecond === 0) return '0 B/s';
    if (bytesPerSecond >= 1024 * 1024 * 1024) {
      return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
    } else if (bytesPerSecond >= 1024 * 1024) {
      return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
    } else if (bytesPerSecond >= 1024) {
      return `${(bytesPerSecond / 1024).toFixed(2)} KB/s`;
    } else {
      return `${bytesPerSecond.toFixed(0)} B/s`;
    }
  };

  const calculateRemainingTime = (): string => {
    if (speedInfo.average <= 0) return '计算中...';
    const remainingBytes = uploadProgress.total - uploadProgress.loaded;
    const remainingSeconds = remainingBytes / speedInfo.average;

    if (remainingSeconds > 3600) {
      const hours = Math.floor(remainingSeconds / 3600);
      const minutes = Math.floor((remainingSeconds % 3600) / 60);
      return `${hours}小时${minutes}分钟`;
    } else if (remainingSeconds > 60) {
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = Math.floor(remainingSeconds % 60);
      return `${minutes}分${seconds}秒`;
    } else {
      return `${Math.floor(remainingSeconds)}秒`;
    }
  };

  // 计算分片哈希
  const calculateChunkHash = async (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const spark = new SparkMD5.ArrayBuffer();
      const fileReader = new FileReader();

      fileReader.addEventListener('load', (e) => {
        try {
          if (e.target?.result) {
            spark.append(e.target.result as ArrayBuffer);
            const hash = spark.end();
            resolve(hash);
          }
        } catch {
          reject(new Error('分片哈希计算失败'));
        }
      });

      fileReader.onerror = () => {
        reject(new Error('分片读取失败'));
      };

      fileReader.readAsArrayBuffer(blob);
    });
  };

  // 网络速度统计
  const updateNetworkStats = (uploadedBytes: number) => {
    const now = Date.now();

    if (networkStats.startTime === 0) {
      networkStats.startTime = now;
      networkStats.lastMeasureTime = now;
      networkStats.lastMeasureBytes = uploadedBytes;
      return;
    }

    const timeDiff = now - networkStats.lastMeasureTime;
    if (timeDiff >= 1000) {
      const bytesDiff = uploadedBytes - networkStats.lastMeasureBytes;
      const currentSpeed = bytesDiff / (timeDiff / 1000);

      speedInfo.current = currentSpeed;
      speedInfo.lastUpdate = now;

      networkStats.speedHistory.push(currentSpeed);
      if (networkStats.speedHistory.length > 10) {
        networkStats.speedHistory.shift();
      }

      const totalTime = (now - networkStats.startTime) / 1000;
      speedInfo.average = totalTime > 0 ? uploadedBytes / totalTime : 0;

      if (currentSpeed > speedInfo.peak) {
        speedInfo.peak = currentSpeed;
      }

      networkStats.lastMeasureTime = now;
      networkStats.lastMeasureBytes = uploadedBytes;
    }
  };

  const resetNetworkStats = () => {
    speedInfo.current = 0;
    speedInfo.average = 0;
    speedInfo.peak = 0;
    speedInfo.lastUpdate = 0;
    networkStats.uploadedBytes = 0;
    networkStats.totalBytes = 0;
    networkStats.startTime = 0;
    networkStats.lastMeasureTime = 0;
    networkStats.lastMeasureBytes = 0;
    networkStats.speedHistory = [];
  };

  // 文件哈希计算
  const calculateFileHash = async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      isCalculatingHash.value = true;
      hashProgress.loaded = 0;
      hashProgress.total = file.size;
      hashProgress.percentage = 0;

      const spark = new SparkMD5.ArrayBuffer();
      const totalChunks = Math.ceil(file.size / hashChunkSize);
      let currentChunkIndex = 0;
      let processedBytes = 0;

      const processNextChunk = () => {
        if (currentChunkIndex >= totalChunks) {
          const hash = spark.end();
          isCalculatingHash.value = false;
          resolve(hash);
          return;
        }

        const start = currentChunkIndex * hashChunkSize;
        const end = Math.min(start + hashChunkSize, file.size);
        const chunkBlob = file.slice(start, end);

        const fileReader = new FileReader();

        fileReader.addEventListener('load', (e) => {
          try {
            if (e.target?.result) {
              spark.append(e.target.result as ArrayBuffer);
              processedBytes += chunkBlob.size;
              currentChunkIndex++;

              hashProgress.loaded = processedBytes;
              hashProgress.percentage = Math.round(
                (processedBytes / file.size) * 100,
              );

              setTimeout(processNextChunk, 0);
            }
          } catch {
            isCalculatingHash.value = false;
            reject(new Error('MD5计算失败'));
          }
        });

        fileReader.onerror = () => {
          isCalculatingHash.value = false;
          reject(new Error('文件读取失败'));
        };

        fileReader.readAsArrayBuffer(chunkBlob);
      };

      processNextChunk();
    });
  };

  // 计算文件哈希
  const startCalculateHash = async (): Promise<void> => {
    if (!currentFile.value) {
      throw new Error('请先选择文件');
    }

    try {
      console.log('=== 开始计算S3文件哈希 ===');
      const calculatedHash = await calculateFileHash(currentFile.value);
      fileHash.value = calculatedHash;
      await checkUploadStatus();
      console.log('=== S3文件哈希计算完成 ===');
    } catch (error) {
      console.error('=== S3文件哈希计算失败 ===', error);
      throw error;
    }
  };

  // 检查上传状态
  const checkUploadStatus = async (): Promise<S3CheckUploadResponse> => {
    if (!currentFile.value || !fileHash.value) {
      throw new Error('文件或哈希值不存在');
    }

    try {
      isCheckingUpload.value = true;
      console.log('🔍 检查S3文件上传状态...');

      const response = await fetch(`${baseUrl}/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          fileHash: fileHash.value,
          fileName: currentFile.value.name,
          fileSize: currentFile.value.size,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result: S3CheckUploadResponse = await response.json();

      if (result.fileExists && result.isComplete) {
        // S3秒传成功
        console.log('⚡ S3秒传成功！文件已存在');
        isSecondTransfer.value = true;
        isCompleted.value = true;
        return result;
      } else if (result.session) {
        // 发现断点续传会话
        console.log('🔄 发现S3断点续传会话');
        uploadSession.value = result.session;
        resumeInfo.value = {
          progress: result.session.progress || 0,
          totalChunks: result.session.totalChunks || 0,
          uploadedCount: result.session.uploadedParts || 0,
        };
        createChunksAndMarkUploaded(currentFile.value, result.session);
      }

      return result;
    } catch (error) {
      console.error('检查S3上传状态失败:', error);
      throw error;
    } finally {
      isCheckingUpload.value = false;
    }
  };

  // 创建分片并标记已上传的分片
  const createChunksAndMarkUploaded = async (
    file: File,
    session: S3UploadSession,
  ) => {
    const fileChunks: S3ChunkInfo[] = [];
    const totalChunks = Math.ceil(file.size / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);
      const partNumber = i + 1; // S3分片号从1开始

      const uploadedPartsCount = session.uploadedParts || 0;
      const isUploaded = uploadedPartsCount > i;

      // 为每个分片计算哈希
      const chunkHash = await calculateChunkHash(blob);

      fileChunks.push({
        index: i,
        partNumber,
        start,
        end,
        blob,
        uploaded: isUploaded,
        progress: isUploaded ? 100 : 0,
        retryCount: 0,
        chunkHash,
      });
    }

    chunks.value = fileChunks;
    updateTotalProgress();
    console.log(
      `S3分片创建完成，总数: ${fileChunks.length}，已上传: ${session.uploadedParts}`,
    );
  };

  // 创建分片
  const createChunks = async (file: File): Promise<S3ChunkInfo[]> => {
    const fileChunks: S3ChunkInfo[] = [];
    const totalChunks = Math.ceil(file.size / chunkSize);

    console.log(
      `创建S3分片，分片大小: ${(chunkSize / 1024 / 1024).toFixed(2)}MB，总数: ${totalChunks}`,
    );

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);
      const partNumber = i + 1; // S3分片号从1开始

      // 为每个分片计算哈希
      const chunkHash = await calculateChunkHash(blob);

      fileChunks.push({
        index: i,
        partNumber,
        start,
        end,
        blob,
        uploaded: false,
        progress: 0,
        retryCount: 0,
        chunkHash,
      });
    }

    console.log(`S3分片创建完成，总数: ${fileChunks.length}`);
    return fileChunks;
  };

  // 初始化S3分片上传
  const initializeUpload = async (): Promise<S3UploadSession> => {
    if (!currentFile.value || !fileHash.value) {
      throw new Error('文件或哈希值不存在');
    }

    try {
      isInitializing.value = true;
      console.log('🚀 初始化S3分片上传...');

      const response = await fetch(`${baseUrl}/initialize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          fileName: currentFile.value.name,
          fileHash: fileHash.value,
          fileSize: currentFile.value.size,
          chunkSize,
          totalChunks: Math.ceil(currentFile.value.size / chunkSize),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log(`S3分片上传初始化结果: ，`, result);

      if (!result.success) {
        throw new Error(result.message || 'S3初始化失败');
      }

      console.log('✅ S3分片上传初始化完成');
      return result.session;
    } catch (error) {
      console.error('❌ S3初始化失败:', error);
      throw error;
    } finally {
      isInitializing.value = false;
    }
  };

  // 上传单个分片 - 修改参数以匹配后端接口
  const uploadChunk = async (chunk: S3ChunkInfo): Promise<boolean> => {
    if (!uploadSession.value || !chunk.chunkHash) {
      throw new Error('上传会话或分片哈希不存在');
    }

    const formData = new FormData();
    formData.append('chunk', chunk.blob);
    formData.append('fileHash', fileHash.value);
    formData.append('chunkIndex', chunk.index.toString()); // 后端期望的是 chunkIndex 而不是 partNumber
    formData.append('chunkHash', chunk.chunkHash);

    try {
      chunk.progress = 1;
      chunk.uploadStartTime = Date.now();

      const xhr = new XMLHttpRequest();

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          xhr.abort();
          reject(new Error('上传超时'));
        }, 60_000);

        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            chunk.progress = Math.round((event.loaded / event.total) * 100);

            const currentUploaded = uploadedSize.value + event.loaded;
            updateNetworkStats(currentUploaded);
            updateTotalProgress();
          }
        });

        xhr.addEventListener('load', () => {
          clearTimeout(timeoutId);

          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const result = JSON.parse(xhr.responseText);

              if (result.success) {
                chunk.uploaded = true;
                chunk.progress = 100;
                chunk.etag = result.data?.etag;
                chunk.uploadEndTime = Date.now();

                updateTotalProgress();
                console.log(
                  `✅ S3分片 ${chunk.partNumber} 上传成功 (ETag: ${result.data?.etag})`,
                );
                resolve(true);
              } else {
                reject(new Error(result.message || 'S3分片上传失败'));
              }
            } catch {
              reject(new Error('响应解析失败'));
            }
          } else {
            reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
          }
        });

        xhr.addEventListener('error', () => {
          clearTimeout(timeoutId);
          reject(new Error('网络错误'));
        });

        xhr.open('POST', `${baseUrl}/chunk`);
        Object.entries(headers).forEach(([key, value]) => {
          xhr.setRequestHeader(key, value);
        });

        xhr.send(formData);
      });
    } catch (error) {
      console.error(`S3分片 ${chunk.partNumber} 上传失败:`, error);
      chunk.retryCount++;
      chunk.progress = 0;
      return false;
    }
  };

  // 更新总体进度
  const updateTotalProgress = () => {
    if (!currentFile.value) return;

    const uploaded = uploadedSize.value;
    const total = currentFile.value.size;

    uploadProgress.loaded = uploaded;
    uploadProgress.total = total;
    uploadProgress.percentage =
      total > 0 ? Math.round((uploaded / total) * 100) : 0;
  };

  // 并发上传分片
  const uploadChunksConcurrently = async (): Promise<void> => {
    const pendingChunks = [...remainingChunks.value];
    const executing: Promise<void>[] = [];

    console.log(
      `开始并发上传 ${pendingChunks.length} 个S3分片，并发数: ${concurrent}`,
    );

    const uploadSingleChunk = async (chunk: S3ChunkInfo): Promise<void> => {
      if (isPaused.value) return;

      let success = false;
      let attempts = 0;

      while (!success && attempts < retryTimes && !isPaused.value) {
        attempts++;
        success = await uploadChunk(chunk);

        if (!success && attempts < retryTimes) {
          console.log(`S3分片 ${chunk.partNumber} 第 ${attempts} 次重试`);
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
        }
      }

      if (!success) {
        throw new Error(
          `S3分片 ${chunk.partNumber} 上传失败，已重试 ${retryTimes} 次`,
        );
      }
    };

    for (const chunk of pendingChunks) {
      if (isPaused.value) break;

      const promise = uploadSingleChunk(chunk).then(() => {
        executing.splice(executing.indexOf(promise), 1);
      });

      executing.push(promise);

      if (executing.length >= concurrent) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
    console.log('所有S3分片上传完成');
  };

  // 完成上传 - 修改参数以匹配后端接口
  const completeUpload = async (): Promise<null | string> => {
    if (!uploadSession.value) {
      throw new Error('上传会话不存在');
    }

    try {
      console.log('🔗 完成S3分片上传...');

      // 后端只需要 fileHash，其他信息从会话中获取
      const response = await fetch(`${baseUrl}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          fileHash: fileHash.value,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (result.success) {
        console.log('✅ S3文件上传完成');
        return result.url || null;
      } else {
        throw new Error(result.message || 'S3完成上传失败');
      }
    } catch (error) {
      console.error('❌ S3完成上传失败:', error);
      throw error;
    }
  };

  // 开始上传
  const startUpload = async (): Promise<null | string> => {
    if (!currentFile.value) {
      throw new Error('请先选择文件');
    }

    if (!fileHash.value) {
      throw new Error('请先计算文件哈希值');
    }

    try {
      console.log('=== 开始S3上传流程 ===');
      resetNetworkStats();
      networkStats.totalBytes = currentFile.value.size;

      isUploading.value = true;
      isCompleted.value = false;
      isPaused.value = false;
      isSecondTransfer.value = false;

      // 检查上传状态
      const checkResult = await checkUploadStatus();

      if (checkResult.fileExists && checkResult.isComplete) {
        // S3秒传成功
        isCompleted.value = true;
        isUploading.value = false;
        isSecondTransfer.value = true;
        return checkResult.url || null;
      }

      // 如果没有会话，创建新的上传会话
      if (!uploadSession.value) {
        uploadSession.value = await initializeUpload();
        chunks.value = await createChunks(currentFile.value);
      }

      updateTotalProgress();

      // 如果所有分片都已上传，直接完成
      if (uploadedChunks.value.length === totalChunks.value) {
        const result = await completeUpload();
        isCompleted.value = true;
        isUploading.value = false;
        return result;
      }

      // 上传剩余分片
      await uploadChunksConcurrently();

      // 完成上传
      const result = await completeUpload();
      isCompleted.value = true;
      isUploading.value = false;

      console.log('=== S3上传流程完成 ===');
      return result;
    } catch (error) {
      console.error('=== S3上传流程失败 ===', error);
      isUploading.value = false;
      throw error;
    }
  };

  // 暂停上传
  const pauseUpload = () => {
    console.log('暂停S3上传');
    isPaused.value = true;
  };

  // 恢复上传
  const resumeUpload = async (): Promise<null | string> => {
    if (!currentFile.value || isCompleted.value) {
      throw new Error('没有可恢复的S3上传任务');
    }

    console.log('恢复S3上传');
    isPaused.value = false;
    isUploading.value = true;

    try {
      await uploadChunksConcurrently();
      const result = await completeUpload();
      isCompleted.value = true;
      isUploading.value = false;
      return result;
    } catch (error) {
      isUploading.value = false;
      throw error;
    }
  };

  // 取消上传
  const cancelUpload = async () => {
    console.log('取消S3上传');
    isPaused.value = true;
    isUploading.value = false;
    isCalculatingHash.value = false;
    isCheckingUpload.value = false;

    if (uploadSession.value) {
      try {
        await fetch(`${baseUrl}/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify({
            fileHash: fileHash.value,
          }),
        });
        console.log('✅ S3上传会话已取消');
      } catch (error) {
        console.error('❌ 取消S3上传会话失败:', error);
      }
    }

    resetNetworkStats();
  };

  // 重置状态
  const reset = () => {
    console.log('重置S3上传状态');
    isUploading.value = false;
    isPaused.value = false;
    isCompleted.value = false;
    isCalculatingHash.value = false;
    isCheckingUpload.value = false;
    isInitializing.value = false;
    isSecondTransfer.value = false;
    currentFile.value = null;
    fileHash.value = '';
    chunks.value = [];
    uploadSession.value = null;
    resumeInfo.value = null;
    uploadProgress.loaded = 0;
    uploadProgress.total = 0;
    uploadProgress.percentage = 0;
    hashProgress.loaded = 0;
    hashProgress.total = 0;
    hashProgress.percentage = 0;
    resetNetworkStats();
  };

  return {
    // 状态
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
    uploadSession,
    uploadProgress,
    hashProgress,
    resumeInfo,

    // 网络速度相关
    speedInfo,
    networkStats,
    formatSpeed,
    calculateRemainingTime,

    // 计算属性
    uploadedChunks,
    remainingChunks,
    totalChunks,
    uploadedSize,

    // 方法
    startCalculateHash,
    checkUploadStatus,
    startUpload,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    reset,
  };
}
