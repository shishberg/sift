import { createRouter, createWebHistory } from 'vue-router';
import SearchView from './views/SearchView.vue';
import SessionView from './views/SessionView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'search',
      component: SearchView,
    },
    {
      path: '/session/:id',
      name: 'session',
      component: SessionView,
    },
  ],
});

export default router;
