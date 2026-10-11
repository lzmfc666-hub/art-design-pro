import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import StudioApp from './studio/StudioApp.vue'
import { studioRouter } from './studio/router'
import 'element-plus/dist/index.css'
import './studio/studio.css'

createApp(StudioApp).use(ElementPlus).use(studioRouter).mount('#app')
