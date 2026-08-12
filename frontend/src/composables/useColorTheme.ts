import { onMounted, ref } from 'vue';

const themeStorageKey = 'evident-loop:theme';

export function useColorTheme() {
  const dark = ref(false);

  onMounted(() => {
    dark.value = document.documentElement.classList.contains('dark');
  });

  function toggleTheme() {
    dark.value = !dark.value;
    document.documentElement.classList.toggle('dark', dark.value);
    window.localStorage.setItem(themeStorageKey, dark.value ? 'dark' : 'light');
  }

  return { dark, toggleTheme };
}
