/* eslint-disable unicorn/prefer-blob-reading-methods */
/* eslint-disable unicorn/prefer-add-event-listener */
import { computed, reactive, ref } from 'vue';

import SparkMD5 from 'spark-md5';

interface ChunkInfo {
  index: number;
  start: number;
  end: number;
  blob: Blob;
  hash: string;
  uploaded: boolean;
  progress: number;
  retryCount: number;
  uploadStartTime?: number;
  uploadEndTime?: number;
  uploadSpeed?: number; // bytes per second
}

interface UploadOptions {
  chunkSize?: number;
  concurrent?: number;
  retryTimes?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  hashChunkSize?: number;
}

interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
}

interface HashProgress {
  loaded: number;
  total: number;
  percentage: number;
}

interface SpeedInfo {
  current: number; // 当前速度 bytes/s
  average: number; // 平均速度 bytes/s
  peak: number; // 峰值速度 bytes/s
  lastUpdate: number; // 最后更新时间戳
}

interface NetworkStats {
  uploadedBytes: number;
  totalBytes: number;
  startTime: number;
  lastMeasureTime: number;
  lastMeasureBytes: number;
  speedHistory: number[]; // 最近10次的速度记录
  chunkSpeeds: number[]; // 分片上传速度记录
}

interface CheckUploadResponse {
  success: boolean;
  shouldUpload: boolean;
  isComplete: boolean;
  message: string;
  url?: string;
  fileName?: string;
  uploadedChunks: string[];
  fileExists: boolean;
  resumeInfo?: {
    progress: number;
    totalChunks: number;
    uploadedCount: number;
  };
}

interface ChunkUploadResponse {
  success: boolean;
  message?: string;
  hash?: string;
  uploadedCount?: number;
  isExisting?: boolean;
}

interface MergeResponse {
  success: boolean;
  message?: string;
  url?: string;
  fileName?: string;
  originalName?: string;
  size?: number;
  fileHash?: string;
}

export function useUpload(options: UploadOptions = {}) {
  const {
    chunkSize = 5 * 1024 * 1024, // 5MB
    concurrent = 3,
    retryTimes = 3,
    baseUrl = '/api/upload',
    headers = {},
    hashChunkSize = 2 * 1024 * 1024, // 2MB for hash calculation
  } = options;

  // 响应式状态
  const isUploading = ref(false);
  const isPaused = ref(false);
  const isCompleted = ref(false);
  const isCalculatingHash = ref(false);
  const isCheckingUpload = ref(false);
  const currentFile = ref<File | null>(null);
  const fileHash = ref('');
  const chunks = ref<ChunkInfo[]>([]);
  const uploadProgress = reactive<UploadProgress>({
    loaded: 0,
    total: 0,
    percentage: 0,
  });
  const hashProgress = reactive<HashProgress>({
    loaded: 0,
    total: 0,
    percentage: 0,
  });

  // 网络速度相关状态
  const speedInfo = reactive<SpeedInfo>({
    current: 0,
    average: 0,
    peak: 0,
    lastUpdate: 0,
  });

  const networkStats = reactive<NetworkStats>({
    uploadedBytes: 0,
    totalBytes: 0,
    startTime: 0,
    lastMeasureTime: 0,
    lastMeasureBytes: 0,
    speedHistory: [],
    chunkSpeeds: [],
  });

  // 新增状态
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

  // 格式化速度显示
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

  // 计算剩余时间
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

  // 更新网络速度统计
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
      // 每秒更新一次
      const bytesDiff = uploadedBytes - networkStats.lastMeasureBytes;
      const currentSpeed = bytesDiff / (timeDiff / 1000);

      // 更新当前速度
      speedInfo.current = currentSpeed;
      speedInfo.lastUpdate = now;

      // 更新速度历史
      networkStats.speedHistory.push(currentSpeed);
      if (networkStats.speedHistory.length > 10) {
        networkStats.speedHistory.shift();
      }

      // 计算平均速度
      const totalTime = (now - networkStats.startTime) / 1000;
      speedInfo.average = totalTime > 0 ? uploadedBytes / totalTime : 0;

      // 更新峰值速度
      if (currentSpeed > speedInfo.peak) {
        speedInfo.peak = currentSpeed;
      }

      networkStats.lastMeasureTime = now;
      networkStats.lastMeasureBytes = uploadedBytes;

      console.log(
        `📈 网络速度 - 当前: ${formatSpeed(currentSpeed)}, 平均: ${formatSpeed(speedInfo.average)}, 峰值: ${formatSpeed(speedInfo.peak)}`,
      );
    }
  };

  // 重置网络统计
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
    networkStats.chunkSpeeds = [];
  };

  /**
   * 手动计算文件哈希值
   */
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

      console.log(
        `开始计算文件MD5，文件大小: ${(file.size / 1024 / 1024).toFixed(2)}MB`,
      );
      console.log(
        `MD5计算分片大小: ${(hashChunkSize / 1024 / 1024).toFixed(2)}MB，总分片数: ${totalChunks}`,
      );

      const processNextChunk = () => {
        if (currentChunkIndex >= totalChunks) {
          const hash = spark.end();
          isCalculatingHash.value = false;
          console.log(`文件MD5计算完成: ${hash}`);
          resolve(hash);
          return;
        }

        const start = currentChunkIndex * hashChunkSize;
        const end = Math.min(start + hashChunkSize, file.size);
        const chunkBlob = file.slice(start, end);

        const fileReader = new FileReader();

        fileReader.onload = (e) => {
          try {
            if (e.target?.result) {
              spark.append(e.target.result as ArrayBuffer);
              processedBytes += chunkBlob.size;
              currentChunkIndex++;

              // 更新进度
              hashProgress.loaded = processedBytes;
              hashProgress.percentage = Math.round(
                (processedBytes / file.size) * 100,
              );

              // 每10个分片打印一次进度
              if (
                currentChunkIndex % 10 === 0 ||
                currentChunkIndex === totalChunks
              ) {
                console.log(
                  `MD5计算进度: ${currentChunkIndex}/${totalChunks} (${hashProgress.percentage}%)`,
                );
              }

              // 使用 setTimeout 避免阻塞UI线程
              setTimeout(processNextChunk, 0);
            }
          } catch (error) {
            isCalculatingHash.value = false;
            console.error('MD5计算过程中出错:', error);
            reject(new Error('MD5计算失败'));
          }
        };

        fileReader.onerror = (error) => {
          isCalculatingHash.value = false;
          console.error('文件读取失败:', error);
          reject(new Error('文件读取失败'));
        };

        fileReader.readAsArrayBuffer(chunkBlob);
      };

      // 开始处理第一个分片
      processNextChunk();
    });
  };

  /**
   * 手动触发计算文件哈希
   */
  const startCalculateHash = async (): Promise<void> => {
    if (!currentFile.value) {
      throw new Error('请先选择文件');
    }

    if (isCalculatingHash.value) {
      throw new Error('正在计算中，请稍等...');
    }

    try {
      console.log('=== 开始计算文件哈希 ===');
      const calculatedHash = await calculateFileHash(currentFile.value);
      fileHash.value = calculatedHash;

      // 计算完哈希后立即检查是否可以秒传或断点续传
      await checkUploadStatus();

      console.log('=== 文件哈希计算完成 ===');
    } catch (error) {
      console.error('=== 文件哈希计算失败 ===', error);
      throw error;
    }
  };

  /**
   * 检查上传状态（秒传和断点续传检查）
   */
  const checkUploadStatus = async (): Promise<CheckUploadResponse> => {
    if (!currentFile.value || !fileHash.value) {
      throw new Error('文件或哈希值不存在');
    }

    try {
      isCheckingUpload.value = true;
      console.log('🔍 检查文件上传状态...');

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

      const result: CheckUploadResponse = await response.json();

      if (result.fileExists && result.isComplete) {
        // 秒传成功
        console.log('⚡ 秒传成功！文件已存在');
        isSecondTransfer.value = true;
        isCompleted.value = true;
        return result;
      } else if (result.uploadedChunks.length > 0) {
        // 发现断点续传
        console.log(
          `🔄 发现断点续传，已上传 ${result.uploadedChunks.length} 个分片`,
        );
        resumeInfo.value = result.resumeInfo;

        // 创建分片并标记已上传的分片
        createChunksAndMarkUploaded(
          currentFile.value,
          fileHash.value,
          result.uploadedChunks,
        );
      }

      return result;
    } catch (error) {
      console.error('检查上传状态失败:', error);
      throw error;
    } finally {
      isCheckingUpload.value = false;
    }
  };

  /**
   * 创建分片并标记已上传的分片
   */
  const createChunksAndMarkUploaded = (
    file: File,
    fileHashValue: string,
    uploadedChunkHashes: string[],
  ) => {
    const fileChunks: ChunkInfo[] = [];
    const totalChunks = Math.ceil(file.size / chunkSize);

    console.log(
      `创建分片，分片大小: ${(chunkSize / 1024 / 1024).toFixed(2)}MB，总数: ${totalChunks}`,
    );

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);
      const chunkHash = `${fileHashValue}_chunk_${i}`;

      const isUploaded = uploadedChunkHashes.includes(chunkHash);

      fileChunks.push({
        index: i,
        start,
        end,
        blob,
        hash: chunkHash,
        uploaded: isUploaded,
        progress: isUploaded ? 100 : 0,
        retryCount: 0,
      });
    }

    chunks.value = fileChunks;
    updateTotalProgress();

    console.log(
      `分片创建完成，总数: ${fileChunks.length}，已上传: ${uploadedChunkHashes.length}`,
    );
  };

  /**
   * 创建文件分片
   */
  const createChunks = (file: File, fileHashValue: string): ChunkInfo[] => {
    const fileChunks: ChunkInfo[] = [];
    const totalChunks = Math.ceil(file.size / chunkSize);

    console.log(
      `开始创建分片，分片大小: ${(chunkSize / 1024 / 1024).toFixed(2)}MB，总数: ${totalChunks}`,
    );

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);

      const chunkHash = `${fileHashValue}_chunk_${i}`;

      fileChunks.push({
        index: i,
        start,
        end,
        blob,
        hash: chunkHash,
        uploaded: false,
        progress: 0,
        retryCount: 0,
      });
    }

    console.log(`分片创建完成，总数: ${fileChunks.length}`);
    return fileChunks;
  };

  /**
   * 上传单个分片（增强版本，包含速度监控）
   */
  const uploadChunk = async (chunk: ChunkInfo): Promise<boolean> => {
    const formData = new FormData();
    formData.append('chunk', chunk.blob);
    formData.append('chunkHash', chunk.hash);
    formData.append('fileHash', fileHash.value);
    formData.append('chunkIndex', chunk.index.toString());
    formData.append('fileName', currentFile.value?.name || '');
    formData.append('totalChunks', chunks.value.length.toString());

    try {
      chunk.progress = 1;
      chunk.uploadStartTime = Date.now();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);

      // 创建自定义的 XMLHttpRequest 来监控上传进度
      const xhr = new XMLHttpRequest();

      return new Promise((resolve, reject) => {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            chunk.progress = Math.round((event.loaded / event.total) * 100);

            // 更新总体进度和网络速度
            const currentUploaded = uploadedSize.value + event.loaded;
            updateNetworkStats(currentUploaded);
            updateTotalProgress();
          }
        });

        xhr.addEventListener('load', () => {
          clearTimeout(timeoutId);

          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const result: ChunkUploadResponse = JSON.parse(xhr.responseText);

              if (result.success) {
                chunk.uploaded = true;
                chunk.progress = 100;
                chunk.uploadEndTime = Date.now();

                // 计算分片上传速度
                if (chunk.uploadStartTime && chunk.uploadEndTime) {
                  const uploadTime =
                    (chunk.uploadEndTime - chunk.uploadStartTime) / 1000;
                  const chunkSize = chunk.end - chunk.start;
                  const chunkSpeed = chunkSize / uploadTime;
                  chunk.uploadSpeed = chunkSpeed;
                  networkStats.chunkSpeeds.push(chunkSpeed);

                  console.log(
                    `⚡ 分片 ${chunk.index} 上传完成，速度: ${formatSpeed(chunkSpeed)}`,
                  );
                }

                updateTotalProgress();

                if (result.isExisting) {
                  console.log(`⚡ 分片 ${chunk.index} 已存在，跳过上传`);
                } else {
                  console.log(`✅ 分片 ${chunk.index} 上传成功`);
                }

                resolve(true);
              } else {
                reject(new Error(result.message || '分片上传失败'));
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

        xhr.addEventListener('timeout', () => {
          reject(new Error('上传超时'));
        });

        xhr.open('POST', `${baseUrl}/chunk`);

        // 设置请求头
        Object.entries(headers).forEach(([key, value]) => {
          xhr.setRequestHeader(key, value);
        });

        xhr.send(formData);
      });
    } catch (error) {
      console.error(`分片 ${chunk.index} 上传失败:`, error);
      chunk.retryCount++;
      chunk.progress = 0;
      return false;
    }
  };

  /**
   * 更新总体上传进度
   */
  const updateTotalProgress = () => {
    if (!currentFile.value) return;

    const uploaded = uploadedSize.value;
    const total = currentFile.value.size;

    uploadProgress.loaded = uploaded;
    uploadProgress.total = total;
    uploadProgress.percentage =
      total > 0 ? Math.round((uploaded / total) * 100) : 0;
  };

  /**
   * 并发上传分片
   */
  const uploadChunksConcurrently = async (): Promise<void> => {
    const pendingChunks = [...remainingChunks.value];
    const executing: Promise<void>[] = [];

    console.log(
      `开始并发上传 ${pendingChunks.length} 个分片，并发数: ${concurrent}`,
    );

    const uploadSingleChunk = async (chunk: ChunkInfo): Promise<void> => {
      if (isPaused.value) return;

      let success = false;
      let attempts = 0;

      while (!success && attempts < retryTimes && !isPaused.value) {
        attempts++;
        success = await uploadChunk(chunk);

        if (!success && attempts < retryTimes) {
          console.log(`分片 ${chunk.index} 第 ${attempts} 次重试`);
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
        }
      }

      if (!success) {
        throw new Error(
          `分片 ${chunk.index} 上传失败，已重试 ${retryTimes} 次`,
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
    console.log('所有分片上传完成');
  };

  /**
   * 合并分片
   */
  const mergeChunks = async (): Promise<MergeResponse> => {
    try {
      console.log(`开始合并分片: ${baseUrl}/merge`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000);

      const response = await fetch(`${baseUrl}/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          fileHash: fileHash.value,
          fileName: currentFile.value?.name,
          chunkHashes: chunks.value.map((chunk) => chunk.hash),
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log('分片合并结果:', result);

      return result;
    } catch (error) {
      console.error('合并分片失败:', error);
      throw new Error(`合并分片失败: ${error}`);
    }
  };

  /**
   * 开始上传
   */
  const startUpload = async (): Promise<null | string> => {
    if (!currentFile.value) {
      throw new Error('请先选择文件');
    }

    if (!fileHash.value) {
      throw new Error('请先计算文件哈希值');
    }

    try {
      console.log('=== 开始上传流程 ===');
      console.log('文件信息:', {
        name: currentFile.value.name,
        size: `${(currentFile.value.size / 1024 / 1024).toFixed(2)}MB`,
        type: currentFile.value.type,
        hash: fileHash.value,
      });

      // 重置网络统计
      resetNetworkStats();
      networkStats.totalBytes = currentFile.value.size;

      isUploading.value = true;
      isCompleted.value = false;
      isPaused.value = false;
      isSecondTransfer.value = false;

      // 检查上传状态
      console.log('步骤1: 检查上传状态...');
      const checkResult = await checkUploadStatus();

      if (checkResult.fileExists && checkResult.isComplete) {
        // 秒传成功
        console.log('⚡ 秒传成功！');
        isCompleted.value = true;
        isUploading.value = false;
        isSecondTransfer.value = true;
        return checkResult.url || null;
      }

      // 如果还没有创建分片，现在创建
      if (chunks.value.length === 0) {
        console.log('步骤2: 创建分片...');
        chunks.value = createChunks(currentFile.value, fileHash.value);
      }

      updateTotalProgress();

      console.log(
        `断点续传检查完成，已上传: ${uploadedChunks.value.length}/${totalChunks.value}`,
      );

      // 如果所有分片都已上传，直接合并
      if (uploadedChunks.value.length === totalChunks.value) {
        console.log('步骤3: 所有分片已存在，直接合并...');
        const mergeResult = await mergeChunks();

        if (mergeResult.success) {
          isCompleted.value = true;
          isUploading.value = false;
          return mergeResult.url || null;
        } else {
          throw new Error(mergeResult.message || '合并失败');
        }
      }

      // 上传剩余分片
      console.log(`步骤3: 开始上传 ${remainingChunks.value.length} 个分片...`);
      await uploadChunksConcurrently();

      // 合并分片
      console.log('步骤4: 正在合并分片...');
      const mergeResult = await mergeChunks();

      if (mergeResult.success) {
        isCompleted.value = true;
        isUploading.value = false;

        // 打印最终统计信息
        console.log('=== 上传统计信息 ===');
        console.log(`平均速度: ${formatSpeed(speedInfo.average)}`);
        console.log(`峰值速度: ${formatSpeed(speedInfo.peak)}`);
        console.log(
          `总用时: ${((Date.now() - networkStats.startTime) / 1000).toFixed(2)}秒`,
        );

        return mergeResult.url || null;
      } else {
        throw new Error(mergeResult.message || '合并失败');
      }
    } catch (error) {
      console.error('=== 上传流程失败 ===', error);
      isUploading.value = false;
      throw error;
    }
  };

  /**
   * 暂停上传
   */
  const pauseUpload = () => {
    console.log('暂停上传');
    isPaused.value = true;
  };

  /**
   * 恢复上传
   */
  const resumeUpload = async (): Promise<null | string> => {
    if (!currentFile.value || isCompleted.value) {
      throw new Error('没有可恢复的上传任务');
    }

    console.log('恢复上传');
    isPaused.value = false;
    isUploading.value = true;

    try {
      // 继续上传剩余分片
      await uploadChunksConcurrently();

      // 合并分片
      const mergeResult = await mergeChunks();

      if (mergeResult.success) {
        isCompleted.value = true;
        isUploading.value = false;
        return mergeResult.url || null;
      } else {
        throw new Error(mergeResult.message || '合并失败');
      }
    } catch (error) {
      isUploading.value = false;
      throw error;
    }
  };

  /**
   * 取消上传
   */
  const cancelUpload = () => {
    console.log('取消上传');
    isPaused.value = true;
    isUploading.value = false;
    isCalculatingHash.value = false;
    isCheckingUpload.value = false;
    resetNetworkStats();
  };

  /**
   * 重置状态
   */
  const reset = () => {
    console.log('重置上传状态');
    isUploading.value = false;
    isPaused.value = false;
    isCompleted.value = false;
    isCalculatingHash.value = false;
    isCheckingUpload.value = false;
    isSecondTransfer.value = false;
    currentFile.value = null;
    fileHash.value = '';
    chunks.value = [];
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
    isSecondTransfer,
    currentFile,
    fileHash,
    chunks,
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
