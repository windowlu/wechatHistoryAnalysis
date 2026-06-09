/**
 * 微信聊天记录分析工具 — 渲染进程前端逻辑
 * 三页式 SPA：配置页 → 运行中页 → 结果页
 */

// ═══════════════════════════════════════════════════════════════
// 状态管理
// ═══════════════════════════════════════════════════════════════

/** @type {Object|null} */
let currentConfig = null;
/** @type {Object|null} */
let lastResult = null;
/** @type {Function|null} */
let unsubscribeLog = null;
/** @type {Function|null} */
let unsubscribeProgress = null;
/** @type {Function|null} */
let unsubscribeComplete = null;
/** @type {Function|null} */
let unsubscribeError = null;

// ═══════════════════════════════════════════════════════════════
// DOM 元素缓存
// ═══════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const pages = {
  config: $('config-page'),
  running: $('running-page'),
  result: $('result-page'),
};

const els = {
  // 配置页
  dataPath: $('data-path'),
  btnBrowseData: $('btn-browse-data'),
  llmProvider: $('llm-provider'),
  apiEndpoint: $('api-endpoint'),
  apiKey: $('api-key'),
  primaryModel: $('primary-model'),
  fallbackModel: $('fallback-model'),
  decryptToolType: $('decrypt-tool-type'),
  pythonPath: $('python-path'),
  concurrency: $('concurrency'),
  batchSize: $('batch-size'),
  outputDir: $('output-dir'),
  logLevel: $('log-level'),
  btnStart: $('btn-start'),
  collapsibleHeader: document.querySelector('.collapsible-header'),
  collapsibleBody: document.querySelector('.collapsible-body'),

  // 运行中页
  progressBar: $('progress-bar'),
  progressPercent: $('progress-percent'),
  progressMessage: $('progress-message'),
  logContent: $('log-content'),
  btnCancel: $('btn-cancel'),

  // 结果页
  statDuration: $('stat-duration'),
  statSessions: $('stat-sessions'),
  statSuccess: $('stat-success'),
  statFailed: $('stat-failed'),
  sessionsTbody: $('sessions-tbody'),
  outputFiles: $('output-files'),
  btnBack: $('btn-back'),

  // 错误弹窗
  errorModal: $('error-modal'),
  errorMessage: $('error-message'),
  btnErrorOk: $('btn-error-ok'),
};

// ═══════════════════════════════════════════════════════════════
// 页面切换
// ═══════════════════════════════════════════════════════════════

function showPage(name) {
  Object.values(pages).forEach((p) => p.classList.remove('active'));
  pages[name].classList.add('active');
}

// ═══════════════════════════════════════════════════════════════
// 配置管理
// ═══════════════════════════════════════════════════════════════

function buildConfig() {
  return {
    extractor: {
      customDataPath: els.dataPath.value || undefined,
      allowedVersions: ['3.9.x', '3.8.x'],
    },
    decryptor: {
      toolType: els.decryptToolType.value,
      pythonPath: els.pythonPath.value || 'python',
      pywxdumpModule: 'pywxdump',
      pywxdumpBiasArgs: [],
      strategy: 'memory',
      outputDir: './temp/decrypted',
      concurrency: parseInt(els.concurrency.value, 10) || 3,
    },
    normalizer: {
      keepRawContent: true,
      timezoneOffset: 480,
      cleaningRules: {
        removeControlChars: true,
        removeXmlTags: true,
        normalizeEmoji: true,
        trimWhitespace: true,
      },
    },
    analyzer: {
      llm: {
        provider: els.llmProvider.value,
        apiEndpoint: els.apiEndpoint.value || 'https://api.openai.com/v1/chat/completions',
        apiKey: els.apiKey.value,
        primaryModel: els.primaryModel.value || 'gpt-4o',
        fallbackModel: els.fallbackModel.value || 'gpt-4o-mini',
        maxContextLength: 8000,
        temperature: 0.3,
        timeoutMs: 120000,
        maxRetries: 2,
      },
      concurrencyLimit: parseInt(els.concurrency.value, 10) || 3,
      compressionThreshold: 6000,
      batchSize: parseInt(els.batchSize.value, 10) || 10,
      enforceJsonMode: true,
      validation: {
        enableRangeCheck: true,
        enableConsistencyCheck: true,
      },
    },
    exporter: {
      outputDir: els.outputDir.value || './output',
      exportJsonl: true,
      exportCsv: true,
    },
    logLevel: els.logLevel.value,
    tempDir: './temp',
  };
}

function loadConfigIntoForm(config) {
  if (!config) return;
  if (config.extractor?.customDataPath) els.dataPath.value = config.extractor.customDataPath;
  if (config.analyzer?.llm?.provider) els.llmProvider.value = config.analyzer.llm.provider;
  if (config.analyzer?.llm?.apiEndpoint) els.apiEndpoint.value = config.analyzer.llm.apiEndpoint;
  if (config.analyzer?.llm?.apiKey) els.apiKey.value = config.analyzer.llm.apiKey;
  if (config.analyzer?.llm?.primaryModel) els.primaryModel.value = config.analyzer.llm.primaryModel;
  if (config.analyzer?.llm?.fallbackModel) els.fallbackModel.value = config.analyzer.llm.fallbackModel;
  if (config.decryptor?.toolType) els.decryptToolType.value = config.decryptor.toolType;
  if (config.decryptor?.pythonPath) els.pythonPath.value = config.decryptor.pythonPath;
  if (config.analyzer?.concurrencyLimit) els.concurrency.value = config.analyzer.concurrencyLimit;
  if (config.analyzer?.batchSize) els.batchSize.value = config.analyzer.batchSize;
  if (config.exporter?.outputDir) els.outputDir.value = config.exporter.outputDir;
  if (config.logLevel) els.logLevel.value = config.logLevel;
}

async function saveCurrentConfig() {
  const config = buildConfig();
  await window.electronAPI.saveConfig(config);
  currentConfig = config;
}

// ═══════════════════════════════════════════════════════════════
// 事件绑定 — 配置页
// ═══════════════════════════════════════════════════════════════

els.btnBrowseData.addEventListener('click', async () => {
  const dir = await window.electronAPI.selectDirectory();
  if (dir) els.dataPath.value = dir;
});

els.collapsibleHeader.addEventListener('click', () => {
  const isCollapsed = els.collapsibleBody.classList.contains('collapsed');
  els.collapsibleBody.classList.toggle('collapsed', !isCollapsed);
  els.collapsibleHeader.classList.toggle('open', isCollapsed);
});

els.btnStart.addEventListener('click', async () => {
  if (!els.dataPath.value) {
    showError('请选择微信数据目录');
    return;
  }
  if (!els.apiKey.value) {
    showError('请输入 API Key');
    return;
  }

  await saveCurrentConfig();
  startAnalysis();
});

// ═══════════════════════════════════════════════════════════════
// 事件绑定 — 运行中页
// ═══════════════════════════════════════════════════════════════

els.btnCancel.addEventListener('click', () => {
  window.electronAPI.cancelAnalysis();
  cleanupListeners();
  showPage('config');
});

// ═══════════════════════════════════════════════════════════════
// 事件绑定 — 结果页
// ═══════════════════════════════════════════════════════════════

els.btnBack.addEventListener('click', () => {
  showPage('config');
});

els.btnErrorOk.addEventListener('click', () => {
  els.errorModal.classList.remove('active');
});

// ═══════════════════════════════════════════════════════════════
// 分析流程
// ═══════════════════════════════════════════════════════════════

function startAnalysis() {
  const config = buildConfig();
  lastResult = null;

  // 重置运行中页
  els.progressBar.style.width = '0%';
  els.progressPercent.textContent = '0%';
  els.progressMessage.textContent = '准备开始';
  els.logContent.innerHTML = '';

  showPage('running');

  // 注册事件监听
  unsubscribeLog = window.electronAPI.onLog((log) => {
    appendLog(log.level, log.message);
  });

  unsubscribeProgress = window.electronAPI.onProgress((progress) => {
    els.progressBar.style.width = `${progress.percent}%`;
    els.progressPercent.textContent = `${progress.percent}%`;
    els.progressMessage.textContent = progress.message;
  });

  unsubscribeComplete = window.electronAPI.onComplete((result) => {
    lastResult = result;
    cleanupListeners();
    showResult(result);
  });

  unsubscribeError = window.electronAPI.onError((error) => {
    cleanupListeners();
    showPage('config');
    showError(error);
  });

  window.electronAPI.startAnalysis(config);
}

function cleanupListeners() {
  if (unsubscribeLog) { unsubscribeLog(); unsubscribeLog = null; }
  if (unsubscribeProgress) { unsubscribeProgress(); unsubscribeProgress = null; }
  if (unsubscribeComplete) { unsubscribeComplete(); unsubscribeComplete = null; }
  if (unsubscribeError) { unsubscribeError(); unsubscribeError = null; }
}

// ═══════════════════════════════════════════════════════════════
// 日志终端
// ═══════════════════════════════════════════════════════════════

function appendLog(level, message) {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.textContent = `[${level.toUpperCase()}] ${message}`;
  els.logContent.appendChild(line);
  els.logContent.scrollTop = els.logContent.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════
// 结果展示
// ═══════════════════════════════════════════════════════════════

function showResult(result) {
  showPage('result');
  renderOverview(result);
  renderCharts(result);
  renderSessions(result);
  renderOutputFiles(result);
}

function renderOverview(result) {
  const stats = result.stats || {};
  const duration = stats.durationMs || 0;
  els.statDuration.textContent = formatDuration(duration);

  const norm = result.stages?.normalization;
  els.statSessions.textContent = norm?.sessionCount ?? '-';

  const analysis = result.stages?.analysis;
  const successCount = analysis?.stats?.successCount ?? 0;
  const failCount = analysis?.stats?.failCount ?? 0;
  els.statSuccess.textContent = successCount;
  els.statFailed.textContent = failCount;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function renderCharts(result) {
  const analysis = result.stages?.analysis;
  if (!analysis?.success?.length) return;

  // 计算各维度平均分
  const dimensions = ['willingness', 'need', 'intention', 'sentiment', 'overall'];
  const dimLabels = { willingness: '意愿', need: '需求', intention: '意向', sentiment: '情感', overall: '综合' };
  const dimScores = {};

  dimensions.forEach((dim) => {
    const scores = analysis.success
      .filter((s) => s.scores && typeof s.scores[dim] === 'number')
      .map((s) => s.scores[dim]);
    dimScores[dim] = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  });

  // 维度柱状图
  const dimChart = echarts.init($('chart-dimensions'));
  dimChart.setOption({
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: dimensions.map((d) => dimLabels[d] || d),
      axisLabel: { fontSize: 12 },
    },
    yAxis: { type: 'value', min: 0, max: 100 },
    series: [{
      type: 'bar',
      data: dimensions.map((d) => Number(dimScores[d].toFixed(1))),
      itemStyle: { color: '#07c160', borderRadius: [4, 4, 0, 0] },
      barWidth: '50%',
    }],
    grid: { left: '10%', right: '10%', bottom: '15%', top: '15%' },
  });

  // 得分分布图
  const overallScores = analysis.success
    .filter((s) => s.scores && typeof s.scores.overall === 'number')
    .map((s) => s.scores.overall);

  const bins = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
  overallScores.forEach((s) => {
    if (s <= 20) bins['0-20']++;
    else if (s <= 40) bins['21-40']++;
    else if (s <= 60) bins['41-60']++;
    else if (s <= 80) bins['61-80']++;
    else bins['81-100']++;
  });

  const distChart = echarts.init($('chart-distribution'));
  distChart.setOption({
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: Object.keys(bins),
      axisLabel: { fontSize: 12 },
    },
    yAxis: { type: 'value' },
    series: [{
      type: 'bar',
      data: Object.values(bins),
      itemStyle: { color: '#10aeff', borderRadius: [4, 4, 0, 0] },
      barWidth: '50%',
    }],
    grid: { left: '10%', right: '10%', bottom: '15%', top: '15%' },
  });
}

function renderSessions(result) {
  const analysis = result.stages?.analysis;
  const norm = result.stages?.normalization;
  if (!analysis) {
    els.sessionsTbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#999">无分析数据</td></tr>';
    return;
  }

  // 合并成功和失败的会话数据
  const sessionMap = new Map();

  // 从 normalization 获取消息数
  const sessions = norm?.sessionCount || 0;
  // 这里需要从 analysis 的 success 和 failed 中获取 talkerId

  analysis.success.forEach((s) => {
    sessionMap.set(s.talkerId, { ...s, status: 'success' });
  });

  analysis.failed.forEach((f) => {
    const existing = sessionMap.get(f.talkerId);
    if (existing) {
      existing.status = 'failed';
      existing.reason = f.reason;
    } else {
      sessionMap.set(f.talkerId, { talkerId: f.talkerId, status: 'failed', reason: f.reason });
    }
  });

  const rows = Array.from(sessionMap.values());
  els.sessionsTbody.innerHTML = rows
    .map((s) => {
      const isFailed = s.status === 'failed';
      const scores = s.scores || {};
      return `
        <tr class="${isFailed ? 'failed' : ''}">
          <td title="${s.talkerId}">${truncate(s.talkerId, 20)}</td>
          <td>${s.messageCount ?? '-'}</td>
          <td>${scores.willingness ?? '-'}</td>
          <td>${scores.need ?? '-'}</td>
          <td>${scores.intention ?? '-'}</td>
          <td>${scores.sentiment ?? '-'}</td>
          <td><strong>${scores.overall ?? '-'}</strong></td>
          <td>
            <span class="status-badge ${s.status}">${isFailed ? '失败' : '成功'}</span>
          </td>
          <td>
            ${isFailed && s.retryable !== false
              ? `<button class="btn-small btn-secondary" onclick="retrySession('${s.talkerId}')">重试</button>`
              : ''}
          </td>
        </tr>
      `;
    })
    .join('');
}

function truncate(str, max) {
  if (!str) return '-';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function renderOutputFiles(result) {
  const exportStage = result.stages?.export;
  if (!exportStage?.filePaths?.length) {
    els.outputFiles.innerHTML = '<p style="color:#999">无输出文件</p>';
    return;
  }

  els.outputFiles.innerHTML = exportStage.filePaths
    .map(
      (fp) => `
        <div class="output-file-item">
          <span class="output-file-path">${fp}</span>
          <div class="output-file-actions">
            <button class="btn-small btn-secondary" onclick="showItemInFolder('${fp.replace(/'/g, "\\'")}')">打开目录</button>
            <button class="btn-small btn-secondary" onclick="openFile('${fp.replace(/'/g, "\\'")}')">查看</button>
          </div>
        </div>
      `
    )
    .join('');
}

// ═══════════════════════════════════════════════════════════════
// 全局函数（供 HTML 内联事件调用）
// ═══════════════════════════════════════════════════════════════

window.showItemInFolder = (filePath) => {
  window.electronAPI.showItemInFolder(filePath);
};

window.openFile = (filePath) => {
  window.electronAPI.openPath(filePath);
};

window.retrySession = (talkerId) => {
  if (!currentConfig) return;
  // 构造重试
  lastResult = null;
  els.progressBar.style.width = '0%';
  els.progressPercent.textContent = '0%';
  els.progressMessage.textContent = '准备重试';
  els.logContent.innerHTML = '';
  showPage('running');

  unsubscribeLog = window.electronAPI.onLog((log) => appendLog(log.level, log.message));
  unsubscribeProgress = window.electronAPI.onProgress((progress) => {
    els.progressBar.style.width = `${progress.percent}%`;
    els.progressPercent.textContent = `${progress.percent}%`;
    els.progressMessage.textContent = progress.message;
  });
  unsubscribeComplete = window.electronAPI.onComplete((result) => {
    lastResult = result;
    cleanupListeners();
    showResult(result);
  });
  unsubscribeError = window.electronAPI.onError((error) => {
    cleanupListeners();
    showPage('config');
    showError(error);
  });

  window.electronAPI.retryFailed([talkerId], currentConfig);
};

// ═══════════════════════════════════════════════════════════════
// 错误弹窗
// ═══════════════════════════════════════════════════════════════

function showError(message) {
  els.errorMessage.textContent = message;
  els.errorModal.classList.add('active');
}

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

async function init() {
  // 加载保存的配置
  const savedConfig = await window.electronAPI.loadConfig();
  if (savedConfig) {
    currentConfig = savedConfig;
    loadConfigIntoForm(savedConfig);
  }

  // 窗口大小变化时重绘图表
  window.addEventListener('resize', () => {
    if (pages.result.classList.contains('active')) {
      const charts = document.querySelectorAll('.chart-container');
      charts.forEach((c) => {
        const chart = echarts.getInstanceByDom(c);
        if (chart) chart.resize();
      });
    }
  });
}

init();
