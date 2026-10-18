# 从直播 flv 分片里抽一帧，输出 JPEG。
# 协议：stdin 一行 JSON {"path": "in.flv", "out": "ignored", "maxWidth": 960}
#   - 成功：stdout 输出 JPEG 二进制，stderr 末行输出一行 JSON 元信息，exit 0
#   - 失败：stderr 写明原因，exit 1
# 为什么要走 stdout 而不是自己写文件：DSH 的子进程在沙箱里，只能写工作区，
# 写 ~/.dsh 下的插件家目录会被拒（PermissionError）。由 Node 侧落盘才行。
# 为什么不用命令行参数传路径：中文用户名经 argv 传给 python 会编码走样。
import sys, json, io
import av
from PIL import Image


def main() -> int:
    try:
        req = json.loads(sys.stdin.readline() or '{}')
    except Exception as e:
        print(f'bad json on stdin: {e}', file=sys.stderr)
        return 2
    src = str(req.get('path') or '')
    try:
        max_w = int(req.get('maxWidth') or 960)
    except Exception:
        max_w = 960
    if not src:
        print('need "path"', file=sys.stderr)
        return 2

    container = av.open(src)
    if not container.streams.video:
        print('no video stream in slice', file=sys.stderr)
        return 1
    vstream = container.streams.video[0]

    img = None
    for frame in container.decode(video=0):
        img = frame.to_image()
        break
    container.close()
    if img is None:
        print('decoded 0 frames', file=sys.stderr)
        return 1

    src_w, src_h = img.size
    if src_w > max_w:
        ratio = max_w / src_w
        img = img.resize((max_w, int(round(src_h * ratio))), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert('RGB').save(buf, 'JPEG', quality=85, optimize=True)
    data = buf.getvalue()

    sys.stderr.write(json.dumps({
        'ok': True,
        'w': img.size[0],
        'h': img.size[1],
        'bytes': len(data),
        'codec': vstream.codec_context.name,
        'source': f'{src_w}x{src_h}',
    }, ensure_ascii=False) + '\n')
    sys.stderr.flush()
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
