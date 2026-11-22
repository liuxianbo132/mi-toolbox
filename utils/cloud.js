const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

// publicConfig 由 workbuddy_cloud_service activate 返回，来源唯一
// 契约 v1.6「环境身份」：生产应用 wbapp_r53cbHLLmYxU6r3LT4wbA6（旧应用 wbapp_mCzPMhf3up1PsJr96aYq59 冻结为存档，勿引用）
const publicConfig = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_r53cbHLLmYxU6r3LT4wbA6_ZmdYunWudLYuvgPHMMQwiYaDMHmFHWGW',
  workBuddyOAuthClientId: 'cb_jq6QyEPkOkJXPcpz0JxS_wbapp_r53cbHLLmYxU6r3LT4wbA6',
}

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  workBuddyOAuthClientId: publicConfig.workBuddyOAuthClientId,
  wx: createDiagnosticWx(wx),
})

module.exports = { cloud, publicConfig }
