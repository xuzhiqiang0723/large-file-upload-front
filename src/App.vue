<script setup lang="ts">
import s3FileUpload from './components/s3-file-upload/index.vue'
</script>

<template>
  <div style="width: 1000px">
    <s3-file-upload />
  </div>
</template>

<style scoped>
.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}
.logo.vue:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>
