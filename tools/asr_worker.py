# -*- coding: utf-8 -*-
"""
asr_worker.py —— 常驻转写进程（给 bili-live 的「听直播」用）。

为什么常驻：WhisperModel 加载要 3-4 秒，每片都重启进程的话，切片 10 秒就有
1/3 的时间在加载模型。所以这里加载一次，然后从 stdin 收路径、往 stdout 吐 JSON 行。

协议（一行一个 JSON）：
  收  {"id": 1, "path": "C:/.../seg-1.flv", "lang": "zh"}
  回  {"id": 1, "ok": true, "text": "……", "lang": "zh", "sec": 10.2, "ms": 1200}
  出错 {"id": 1, "ok": false, "error": "..."}
  {"cmd": "quit"} 退出
启动完先吐一行 {"ready": true, "model": "small"}。

模型缓存复用 bili-duty 已下好的那份（faster-whisper-small，483MB），不重复下载。
"""
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 家目录：默认 bili-duty（模型与缓存都在那儿）；HUB 环境可由外部覆盖
DUTY_HOME = os.environ.get('BILI_LIVE_HF_HOME') or os.path.join(
    os.path.expanduser('~'), '.dsh', 'bili-duty', '.hf-cache')
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HOME', DUTY_HOME)
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main() -> int:
    model_name = sys.argv[1] if len(sys.argv) > 1 else 'small'
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        emit({'ready': False, 'error': 'faster_whisper 不可用：%s' % e})
        return 1

    try:
        model = WhisperModel(model_name, device='cpu', compute_type='int8')
    except Exception as e:  # noqa: BLE001
        emit({'ready': False, 'error': '加载模型 %s 失败：%s' % (model_name, e)})
        return 1
    emit({'ready': True, 'model': model_name})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get('cmd') == 'quit':
            break
        rid = req.get('id')
        path = req.get('path')
        if not path or not os.path.exists(path):
            emit({'id': rid, 'ok': False, 'error': '找不到音频文件：%s' % path})
            continue
        t0 = time.time()
        # 主播常常中日英混着说：auto = 每片自己去判语言，不钉死中文。
        # 钉死语言时才喂对应的提示词 —— 提示词会强行把语言往那边拉，
        # auto 下必须留空，否则日语/英语会被听写成中文。
        lang = str(req.get('lang') or 'auto').lower()
        prompts = {
            'zh': '以下是普通话的直播，主播在打游戏并和观众聊天，用简体中文。',
            'ja': '以下は日本語のライブ配信です。',
            'en': 'The following is an English live stream.',
        }
        kwargs = {
            'vad_filter': True,          # 掐静音，省时间也少幻觉
            'condition_on_previous_text': False,
        }
        if lang in prompts:
            kwargs['language'] = lang
            kwargs['initial_prompt'] = prompts[lang]
        else:
            kwargs['language'] = None    # 自动检测
        try:
            segs, info = model.transcribe(path, **kwargs)
            text = ''.join(s.text for s in segs).strip()
            emit({
                'id': rid, 'ok': True, 'text': text,
                'lang': info.language or '', 'sec': round(float(info.duration or 0), 2),
                'ms': int((time.time() - t0) * 1000),
            })
        except Exception as e:  # noqa: BLE001
            emit({'id': rid, 'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
