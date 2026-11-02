/**
 * Composer voice picker.
 *
 * Lets a human choose the narration voice directly instead of asking the model
 * and listening to files in a folder. It talks to three Host routes:
 *
 *   GET  /_dsh/video-remix/voice    list voices + current selection
 *   POST /_dsh/video-remix/voice    persist a selection
 *   GET  /_dsh/video-remix/sample   stream a preview mp3 for a voice id
 *   POST /_dsh/video-remix/upload   accept an uploaded audio file as a custom voice
 *
 * The selection is stored Host-side, so render_video picks it up with no extra
 * parameter — the same pattern as the video-eyes interval slider.
 */
window.__ModuleLoader__.load({
  id: 'dsh-video-remix',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const VOICE_ROUTE = '/_dsh/video-remix/voice'
    const SAMPLE_ROUTE = '/_dsh/video-remix/sample'
    const UPLOAD_ROUTE = '/_dsh/video-remix/upload'

    // Solid translucent fills instead of low opacity: the composer sits on a
    // Theme variables with fallbacks: if DSH renames one, the control degrades
    // to a readable grey instead of becoming transparent.
    const SURFACE = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.22))'
    const SURFACE_HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.34))'
    // The native dropdown paints its own surface; without explicit colours the
    // options inherit light text onto a light list and become unreadable.
    const MENU_BG = 'var(--dsw-menu-surface-fill, #242933)'
    const MENU_FG = 'var(--dsw-alias-label-primary-foreground, #e9edf5)'

    const barStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 12px 8px',
      fontSize: 12,
      color: 'inherit',
      userSelect: 'none',
      flexWrap: 'wrap',
      rowGap: 6,
    }

    const btnStyle = {
      fontSize: 11,
      lineHeight: '18px',
      padding: '1px 8px',
      borderRadius: 5,
      border: '1px solid currentColor',
      background: SURFACE,
      color: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const selectStyle = {
      fontSize: 12,
      lineHeight: '18px',
      padding: '2px 6px',
      borderRadius: 5,
      border: '1px solid currentColor',
      background: SURFACE,
      color: 'inherit',
      maxWidth: 240,
      cursor: 'pointer',
    }

    const metaStyle = { fontSize: 11, opacity: 0.9, whiteSpace: 'nowrap' }

    const COLLAPSE_KEY = 'dsh-video-remix:voice-collapsed'

    function readCollapsed() {
      try {
        return window.localStorage.getItem(COLLAPSE_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeCollapsed(value) {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
      } catch {
        // private mode / storage disabled — collapsing just won't persist
      }
    }

    function VoicePicker() {
      const [collapsed, setCollapsed] = React.useState(readCollapsed)
      const [state, setState] = React.useState(null)
      const [offline, setOffline] = React.useState(false)
      const [playing, setPlaying] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [hint, setHint] = React.useState('')
      const [hover, setHover] = React.useState(false)
      const audioRef = React.useRef(null)
      const fileRef = React.useRef(null)

      const load = React.useCallback(() => {
        fetch(VOICE_ROUTE, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('offline'))))
          .then((payload) => {
            if (!payload || !payload.ok) return
            setState(payload)
            setOffline(false)
          })
          .catch(() => setOffline(true))
      }, [])

      React.useEffect(() => {
        load()
        return () => {
          if (audioRef.current) {
            audioRef.current.pause()
            audioRef.current = null
          }
        }
      }, [load])

      const select = (voice) => {
        setState((prev) => (prev ? { ...prev, selected: { engine: voice.engine, name: voice.id } } : prev))
        fetch(VOICE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ engine: voice.engine, name: voice.id }),
        }).catch(() => {})
      }

      const preview = (voice) => {
        if (audioRef.current) {
          audioRef.current.pause()
          audioRef.current = null
        }
        if (playing === voice.id) {
          setPlaying(null)
          return
        }
        const audio = new Audio(`${SAMPLE_ROUTE}?name=${encodeURIComponent(voice.id)}`)
        audio.onended = () => setPlaying(null)
        audio.onerror = () => {
          setPlaying(null)
          setHint('没有试听文件，先运行 voice_samples 生成一次')
        }
        audioRef.current = audio
        setPlaying(voice.id)
        audio.play().catch(() => {
          setPlaying(null)
          setHint('浏览器阻止了播放，再点一次')
        })
      }

      const upload = (event) => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        setBusy(true)
        setHint('')
        const reader = new FileReader()
        reader.onload = () => {
          const base64 = String(reader.result).replace(/^data:[^,]*,/, '')
          fetch(UPLOAD_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, data: base64 }),
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('upload failed'))))
            .then((payload) => {
              if (payload && payload.ok) setState(payload)
              setHint(`已上传 ${file.name}`)
            })
            .catch(() => setHint('上传失败'))
            .finally(() => setBusy(false))
        }
        reader.onerror = () => {
          setBusy(false)
          setHint('读取文件失败')
        }
        reader.readAsDataURL(file)
        event.target.value = ''
      }

      const toggle = () => {
        const next = !collapsed
        setCollapsed(next)
        writeCollapsed(next)
      }

      // Collapsed: one chip that reopens the picker, so the composer stays clean.
      if (collapsed) {
        const sel = state && state.selected ? state.selected : null
        const allVoices = state ? [...(state.voices || []), ...(state.custom || [])] : []
        const cur = sel ? allVoices.find((v) => v.id === sel.name) : null
        return h(
          'div',
          { style: barStyle },
          h(
            'button',
            {
              key: 'open',
              type: 'button',
              onClick: toggle,
              title: '展开音色选择',
              style: btnStyle,
            },
            `🎙 音色${cur ? ' · ' + cur.label : ''} ▸`,
          ),
        )
      }

      if (offline || !state) {
        return h(
          'div',
          { style: { ...barStyle, fontSize: 11, opacity: 0.75 } },
          '配音音色：插件未连接',
        )
      }

      const selected = state.selected || { engine: 'edge', name: 'zh-CN-YunxiNeural' }
      const all = [...(state.voices || []), ...(state.custom || [])]
      const currentVoice = all.find((v) => v.id === selected.name)

      const groups = []
      for (const voice of state.voices || []) {
        if (!groups.includes(voice.group)) groups.push(voice.group)
      }

      const renderOption = (voice) =>
        h(
          'option',
          {
            key: voice.id,
            value: voice.id,
            style: { backgroundColor: MENU_BG, color: MENU_FG },
          },
          `${voice.recommended ? '★ ' : ''}${voice.label}${voice.gender ? ' · ' + voice.gender : ''}`,
        )

      const onSelect = (event) => {
        const voice = all.find((v) => v.id === event.target.value)
        if (voice) select(voice)
      }

      return h(
        'div',
        { style: barStyle },
        h('span', { key: 'label', style: { whiteSpace: 'nowrap', fontWeight: 500 } }, '配音音色'),

        h(
          'select',
          {
            key: 'select',
            value: selected.name,
            onChange: onSelect,
            'aria-label': '选择配音音色',
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: hover ? { ...selectStyle, background: SURFACE_HOVER } : selectStyle,
          },
          groups.map((group) =>
            h(
              'optgroup',
              {
                key: group,
                label: group,
                style: { backgroundColor: MENU_BG, color: MENU_FG },
              },
              (state.voices || []).filter((v) => v.group === group).map(renderOption),
            ),
          ),
          (state.custom || []).length
            ? h(
                'optgroup',
                {
                  key: '自定义',
                  label: '自定义（上传）',
                  style: { backgroundColor: MENU_BG, color: MENU_FG },
                },
                (state.custom || []).map(renderOption),
              )
            : null,
        ),

        h(
          'button',
          {
            key: 'play',
            type: 'button',
            onClick: () => currentVoice && preview(currentVoice),
            title: '试听当前音色',
            style: { ...btnStyle, background: playing ? SURFACE_HOVER : SURFACE },
          },
          playing ? '⏸ 停止' : '▶ 试听',
        ),

        h(
          'button',
          {
            key: 'upload',
            type: 'button',
            onClick: () => fileRef.current && fileRef.current.click(),
            disabled: busy,
            title: '上传自己的音频作为自定义音色',
            style: { ...btnStyle, opacity: busy ? 0.55 : 1 },
          },
          busy ? '上传中…' : '＋ 上传声音',
        ),
        h('input', {
          key: 'file',
          ref: fileRef,
          type: 'file',
          accept: 'audio/*',
          onChange: upload,
          style: { display: 'none' },
        }),

        currentVoice
          ? h('span', { key: 'meta', style: metaStyle }, `${currentVoice.group} · ${currentVoice.label}`)
          : null,

        hint ? h('span', { key: 'hint', style: { ...metaStyle, opacity: 0.8 } }, hint) : null,

        h(
          'button',
          {
            key: 'collapse',
            type: 'button',
            onClick: toggle,
            title: '收起音色选择（下次打开仍保持收起）',
            style: { ...btnStyle, marginLeft: 'auto' },
          },
          '收起 ▴',
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'video-remix-voice', order: 6 },
            VoicePicker,
          ),
        )
      },
    }
  },
})
