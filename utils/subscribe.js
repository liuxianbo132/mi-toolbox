// 订阅消息授权收集（一次性授权）：埋点位置＝录入成功后 / 看板首屏（M1）；打卡完成埋点属 M2。
// 授权结果不影响业务流程：拒绝/失败均静默，推送失败时由看板红点兜底（契约·推送链路）。

// TODO(等总控下发): 「临期提醒」订阅消息模板 id。未下发前保持空串，调用方拿到的返回为 false，授权弹窗静默跳过。
const EXPIRY_TEMPLATE_ID = ''

// 返回 true 表示实际发起了授权弹窗（调用方可据此决定是否记录"已询问"标记）
function askExpirySubscribe() {
  if (!EXPIRY_TEMPLATE_ID) return false
  if (typeof wx === 'undefined' || !wx.requestSubscribeMessage) return false
  try {
    wx.requestSubscribeMessage({
      tmplIds: [EXPIRY_TEMPLATE_ID],
      complete: function () {},
    })
    return true
  } catch (e) {
    // 非用户手势上下文调用可能抛错：授权是可选增强，静默忽略
    return false
  }
}

module.exports = { askExpirySubscribe, EXPIRY_TEMPLATE_ID }
