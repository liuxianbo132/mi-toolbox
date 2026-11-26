Component({
  properties: {
    icon: { type: String, value: '' },
    illustration: { type: Boolean, value: false },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    actionText: { type: String, value: '' },
    compact: { type: Boolean, value: false },
  },
  methods: {
    onAction() {
      this.triggerEvent('action')
    },
  },
})
