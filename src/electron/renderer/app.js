/**
 * 微信客户识别系统 — 渲染进程前端逻辑
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
  filterNonCustomers: $('filter-non-customers'),
  targetCustomerType: $('target-customer-type'),
  minConfidence: $('min-confidence'),
  lookbackDays: $('lookback-days'),
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
  statCustomers: $('stat-customers'),
  statB2b: $('stat-b2b'),
  statB2c: $('stat-b2c'),
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
        provider: 'kimi',
        apiEndpoint: 'https://api.moonshot.cn/v1/chat/completions',
        apiKey: currentConfig?.analyzer?.llm?.apiKey || '',
        primaryModel: 'kimi-k2-6',
        fallbackModel: 'kimi-k2-6',
        maxContextLength: 32000,
        temperature: 0.3,
        timeoutMs: 120000,
        maxRetries: 2,
      },
      concurrencyLimit: parseInt(els.concurrency.value, 10) || 3,
      compressionThreshold: 6000,
      batchSize: parseInt(els.batchSize.value, 10) || 10,
      enforceJsonMode: true,
      classification: {
        filterNonCustomers: els.filterNonCustomers.checked,
        minConfidence: parseFloat(els.minConfidence.value) || 0.6,
        targetCustomerType: els.targetCustomerType.value || undefined,
        lookbackDays: parseInt(els.lookbackDays.value, 10) || 7,
      },
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
  if (config.analyzer?.classification) {
    const cls = config.analyzer.classification;
    if (typeof cls.filterNonCustomers === 'boolean') els.filterNonCustomers.checked = cls.filterNonCustomers;
    if (cls.minConfidence !== undefined) els.minConfidence.value = cls.minConfidence;
    if (cls.targetCustomerType) els.targetCustomerType.value = cls.targetCustomerType;
    if (cls.lookbackDays !== undefined) els.lookbackDays.value = cls.lookbackDays;
  }
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

  const analysis = result.stages?.analysis;
  if (analysis?.stats) {
    els.statCustomers.textContent = analysis.stats.customerCount ?? '-';
    els.statB2b.textContent = analysis.stats.b2bCount ?? '-';
    els.statB2c.textContent = analysis.stats.b2cCount ?? '-';
  } else {
    els.statCustomers.textContent = '-';
    els.statB2b.textContent = '-';
    els.statB2c.textContent = '-';
  }
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

  const success = analysis.success;

  // ═══════════════════════════════════════════════════════════
  // 客户类型分布饼图
  // ═══════════════════════════════════════════════════════════
  const b2bCount = success.filter((s) => s.classification?.customerType === 'b2b').length;
  const b2cCount = success.filter((s) => s.classification?.customerType === 'b2c').length;
  const nonCustomerCount = success.filter((s) => !s.classification?.isCustomer).length;

  const typeChart = echarts.init($('chart-type-distribution'));
  typeChart.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, data: ['B端客户', 'C端客户', '非客户'] },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: false,
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      data: [
        { value: b2bCount, name: 'B端客户', itemStyle: { color: '#07c160' } },
        { value: b2cCount, name: 'C端客户', itemStyle: { color: '#10aeff' } },
        { value: nonCustomerCount, name: '非客户', itemStyle: { color: '#c9c9c9' } },
      ],
    }],
  });

  // ═══════════════════════════════════════════════════════════
  // 需求类型分布柱状图
  // ═══════════════════════════════════════════════════════════
  const demandMap = new Map();
  for (const s of success) {
    if (!s.classification?.isCustomer || !s.customerInfo) continue;
    const demand = s.customerInfo.demandType;
    if (demand) {
      demandMap.set(demand, (demandMap.get(demand) || 0) + 1);
    }
  }

  const demandData = Array.from(demandMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const demandChart = echarts.init($('chart-demand-distribution'));
  demandChart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: '3%', right: '4%', bottom: '3%', top: '10%', containLabel: true },
    xAxis: {
      type: 'category',
      data: demandData.map((d) => d[0]),
      axisLabel: { fontSize: 11, rotate: 30 },
    },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{
      type: 'bar',
      data: demandData.map((d) => d[1]),
      itemStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: '#07c160' },
          { offset: 1, color: '#2ee593' },
        ]),
        borderRadius: [4, 4, 0, 0],
      },
      barWidth: '50%',
    }],
  });
}

function renderSessions(result) {
  const analysis = result.stages?.analysis;
  if (!analysis) {
    els.sessionsTbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#999">无分析数据</td></tr>';
    return;
  }

  // 合并成功和失败的会话数据
  const sessionMap = new Map();

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
      const cls = s.classification || {};
      const isCustomer = cls.isCustomer;
      const customerType = cls.customerType || '';
      const subType = cls.subType || '';
      const confidence = cls.confidence ?? 0;

      // 提取关键信息
      let demandOrExam = '-';
      let region = '-';
      let followUpStatus = '-';

      if (isCustomer && s.customerInfo) {
        const info = s.customerInfo;
        if (customerType === 'b2b') {
          demandOrExam = info.demandType || info.demandDetail || '-';
          region = info.region || '-';
          followUpStatus = info.followUpStatus || '-';
        } else {
          demandOrExam = info.examType || info.demandType || '-';
          region = info.region || '-';
          followUpStatus = info.followUpStatus || '-';
        }
      }

      const typeBadge = isCustomer
        ? `<span class="type-badge ${customerType}">${customerType === 'b2b' ? 'B端' : 'C端'}</span>`
        : '<span class="type-badge non">非客户</span>';

      return `
        <tr class="${isFailed ? 'failed' : ''}">
          <td title="${s.talkerId}">${truncate(s.talkerName || s.talkerId, 16)}</td>
          <td>${typeBadge}</td>
          <td>${subType || '-'}</td>
          <td>${demandOrExam}</td>
          <td>${region}</td>
          <td>${followUpStatus}</td>
          <td>${isCustomer ? (confidence * 100).toFixed(0) + '%' : '-'}</td>
          <td>${s.messageCount ?? '-'}</td>
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
