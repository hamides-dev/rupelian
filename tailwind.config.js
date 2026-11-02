import forms from "@tailwindcss/forms";

export default {
  content: ["./index.html", "./src/**/*.{js,css}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        yt: {
          red: "#FF0000",
          redHover: "#CC0000",
          dark: "#0F0F0F",
          elevated: "#212121",
          card: "#1F1F1F",
          chip: "#272727",
          border: "#383838",
          textMuted: "#AAAAAA"
        }
      },
      fontFamily: {
        sans: ["Roboto", "YouTube Sans", "Segoe UI", "system-ui", "-apple-system", "sans-serif"],
        jp: ["Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", "sans-serif"]
      },
      boxShadow: {
        "yt-red": "0 0 16px rgba(255, 0, 0, 0.65)",
        "yt-subtle": "0 10px 30px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.08)"
      }
    }
  },
  plugins: [forms]
};
