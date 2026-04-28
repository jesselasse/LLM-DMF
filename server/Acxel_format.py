"""
Activation sequence format conversion utilities
"""
import sys



def scale_activation_sequence(activation_sequence, scale_factor):
    """
    Scale activation sequence by a uniform factor
    
    Scales both positions and sizes: (x, y, w, h) -> (x*scale, y*scale, w*scale, h*scale)
    This maintains aspect ratios and inter-droplet spacing proportionally
    
    Args:
        activation_sequence: list of (time_step, [(x, y, w, h), ...])
        scale_factor: scaling factor (2 for 2x, 3 for 3x, etc.)
        chip_width: optional chip width for boundary checking
        chip_height: optional chip height for boundary checking
    
    Returns:
        Scaled activation sequence with same structure
        
    Raises:
        ValueError: if scale_factor <= 0 or scaled activations exceed chip boundaries
    """
    if scale_factor <= 0:
        raise ValueError(f"scale_factor must be > 0, got {scale_factor}")
    
    if scale_factor == 1:
        return activation_sequence
    
    scaled_sequence = []
    
    for time_step, activations in activation_sequence:
        if not activations:
            scaled_sequence.append((time_step, []))
            continue
        
        scaled_activations = []
        for x, y, w, h in activations:
            scaled_x = int(x * scale_factor)
            scaled_y = int(y * scale_factor)
            scaled_w = int(w * scale_factor)
            scaled_h = int(h * scale_factor)
        
            
            scaled_activations.append((scaled_x, scaled_y, scaled_w, scaled_h))
        
        scaled_sequence.append((time_step, scaled_activations))
    
    return scaled_sequence


def scale_activation_sequence_xy(activation_sequence, scale_x, scale_y):
    """
    Scale activation sequence by independent x/y factors.

    (x, y, w, h) -> (x*scale_x, y*scale_y, w*scale_x, h*scale_y)
    """
    if scale_x <= 0 or scale_y <= 0:
        raise ValueError(
            f"scale_x/scale_y must be > 0, got scale_x={scale_x}, scale_y={scale_y}"
        )

    if scale_x == 1 and scale_y == 1:
        return activation_sequence

    scaled_sequence = []
    for time_step, activations in activation_sequence:
        if not activations:
            scaled_sequence.append((time_step, []))
            continue

        scaled_activations = []
        for x, y, w, h in activations:
            scaled_activations.append(
                (
                    int(x * scale_x),
                    int(y * scale_y),
                    int(w * scale_x),
                    int(h * scale_y),
                )
            )
        scaled_sequence.append((time_step, scaled_activations))
    return scaled_sequence


def translate_activation_sequence(activation_sequence, offset_x=0, offset_y=0):
    """
    平移激活序列
    
    所有激活的坐标都增加指定的偏移量：(x, y, w, h) -> (x+offset_x, y+offset_y, w, h)
    
    Args:
        activation_sequence: list of (time_step, [(x, y, w, h), ...])
        offset_x: X方向偏移量（默认0）
        offset_y: Y方向偏移量（默认0）
    
    Returns:
        平移后的激活序列
    """
    if offset_x == 0 and offset_y == 0:
        return activation_sequence
    
    translated = []
    for time_step, activations in activation_sequence:
        new_acts = [(x + offset_x, y + offset_y, w, h) for x, y, w, h in activations]
        translated.append((time_step, new_acts))
    
    return translated

def translate_sequence(sequence, offset_x: int, offset_y: int):
    """
    Translate all cells in a sequence by given offset
    
    Args:
        sequence: List of (time_step, cells) where cells = [(dx, dy, w, h), ...]
        offset_x: X offset to add
        offset_y: Y offset to add
        
    Returns:
        New sequence with translated cells
    """
    translated = []
    for time_step, cells in sequence:
        new_cells = [
            (dx + offset_x, dy + offset_y, w, h)
            for dx, dy, w, h in cells
        ]
        translated.append((time_step, new_cells))
    return translated


def rotate_sequence_90(sequence, rotation_deg: int, center):
    
    """
    Rotate all cells in a sequence by 90-degree increments (counterclockwise)
    
    Rotation is around the specified center point. The rectangle's top-left corner (dx, dy)
    and dimensions (w, h) are transformed.
    
    Args:
        sequence: List of (time_step, cells) where cells = [(dx, dy, w, h), ...]
        rotation_deg: Rotation angle in degrees (0, 90, 180, 270)
        center: Tuple (cx, cy) for rotation center, defaults to (0, 0)
        
    Returns:
        New sequence with rotated cells
    """
    k = (rotation_deg // 90) % 4
    cx, cy = center
    
    rotated = []
    for time_step, cells in sequence:
        new_cells = []
        for dx, dy, w, h in cells:
            # 平移到原点
            px, py = dx - cx, dy - cy
            
            if k == 0:  # 0°: no rotation
                nx, ny, nw, nh = px, py, w, h
            elif k == 1:  # 90° ccw
                nx, ny, nw, nh = -py - h, px, h, w
            elif k == 2:  # 180°
                nx, ny, nw, nh = -px - w, -py - h, w, h
            else:  # k == 3: 270° ccw (or 90° cw)
                nx, ny, nw, nh = py, -px - w, h, w
            
            # 平移回圆心
            nx, ny = nx + cx, ny + cy
            new_cells.append((nx, ny, nw, nh))
        rotated.append((time_step, new_cells))
    
    return rotated

def filter_by_x_range(activation_sequence, min_x=None, max_x=None):
    """
    按X坐标范围过滤激活序列
    
    删除不在指定X坐标范围内的激活
    
    Args:
        activation_sequence: list of (time_step, [(x, y, w, h), ...])
        min_x: 最小X坐标（包含），None表示不限制下限
        max_x: 最大X坐标（包含），None表示不限制上限
    
    Returns:
        过滤后的激活序列
    """
    # Thin wrapper: delegate to filter_by_coordinate_range for consistency
    return filter_by_coordinate_range(
        activation_sequence,
        min_x=min_x,
        max_x=max_x,
        min_y=None,
        max_y=None,
    )


def filter_by_coordinate_range(activation_sequence, min_x=None, max_x=None, min_y=None, max_y=None):
    """
    按坐标范围过滤激活序列
    
    删除不在指定坐标范围内的激活
    
    Args:
        activation_sequence: list of (time_step, [(x, y, w, h), ...])
        min_x: 最小X坐标（包含），None表示不限制
        max_x: 最大X坐标（包含），None表示不限制
        min_y: 最小Y坐标（包含），None表示不限制
        max_y: 最大Y坐标（包含），None表示不限制
    
    Returns:
        过滤后的激活序列
    """
    filtered = []
    for time_step, activations in activation_sequence:
        new_acts = []
        for x, y, w, h in activations:
            if ((min_x is None or x > min_x) and 
                (max_x is None or x <= max_x) and
                (min_y is None or y > min_y) and
                (max_y is None or y <= max_y)):
                new_acts.append((x, y, w, h))
        filtered.append((time_step, new_acts))
    
    return filtered


def load_activation_sequence_from_txt(input_path):
    """
    Load activation sequence from Acxel format text file
    
    Format: each line represents one time step
    Each rectangle: (x,y)(w,h);
    Each line ends with -1000
    
    Args:
        input_path: path to the input text file
    
    Returns:
        activation_sequence: list of (time_step, [(x, y, w, h), ...])
    """
    activation_sequence = []
    
    with open(input_path, 'r') as f:
        for time_step, line in enumerate(f):
            line = line.strip()
            
            # Skip empty lines
            if not line:
                activation_sequence.append((time_step, []))
                continue
            
            # Remove trailing -1000
            if line.endswith("-1000"):
                line = line[:-5]
            
            # Parse activation regions
            activations = []
            if line:  # Non-empty after removing -1000
                # Split by semicolon to get individual regions
                regions = line.split(";")
                
                for region in regions:
                    region = region.strip()
                    if not region:
                        continue
                    
                    # Parse format: (x,y)(w,h)
                    # Find the two pairs of parentheses
                    try:
                        # Find position part (x,y)
                        pos_start = region.find('(')
                        pos_end = region.find(')')
                        pos_str = region[pos_start+1:pos_end]
                        x, y = map(int, pos_str.split(','))
                        
                        # Find size part (w,h)
                        size_start = region.find('(', pos_end)
                        size_end = region.find(')', size_start)
                        size_str = region[size_start+1:size_end]
                        w, h = map(int, size_str.split(','))
                        
                        activations.append((x, y, w, h))
                    except (ValueError, IndexError) as e:
                        print(f"Warning: Failed to parse region '{region}' at time step {time_step}: {e}")
                        continue
            
            activation_sequence.append((time_step, activations))
    
    print(f"\n[Loaded] Activation sequence loaded from: {input_path}")
    print(f"  Total time steps: {len(activation_sequence)}")
    
    return activation_sequence


def save_activation_sequence_to_txt(activation_sequence, output_path):
    """
    Convert activation sequence to text format and save to file
    
    Format: each line represents one time step
    Each rectangle: (x,y)(w,h);
    Each line ends with -1000
    
    Args:
        activation_sequence: list of (time_step, [(x, y, w, h), ...])
        output_path: path to save the output file
    """
    with open(output_path, 'w') as f:
        for time_step, activations in activation_sequence:
            if not activations:
                # Empty line with just -1000
                f.write("-1000\n")
                continue
            
            # Format each activation as (x,y)(w,h);
            parts = []
            for x, y, w, h in activations:
                parts.append(f"({x},{y})({w},{h})")
            
            # Join with semicolons and add -1000 at end
            line = ";".join(parts) + "-1000\n"
            f.write(line)
    
    print(f"\n[Saved] Activation sequence saved to: {output_path}")



def merge_sequences(sequences):
    merged = {}
    for seq in sequences:
        for cycle, cells in seq:
            if cycle not in merged:
                merged[cycle] = []
            merged[cycle].extend(cells)
    final_sequence = [(cycle, merged[cycle]) for cycle in sorted(merged.keys())]
    return final_sequence


def make_continuous_sequence(sequence, max_cycle: int):
    """
    将稀疏的激活序列转换为连续的每个cycle都有激活的序列
    
    对于原始序列中没有的cycle，使用前一个cycle的激活（相当于添加静止帧）
    
    Args:
        sequence: 原始序列 [(cycle, cells), ...]，其中 cells 是激活的电极列表
        max_cycle: 最大cycle数
    
    Returns:
        List[Tuple]: 连续序列 [(min_cycle, cells), ..., (max_cycle, cells)]
    
    Example:
        >>> seq = [(0, [(0,0)]), (2, [(1,1)]), (5, [(2,2)])]
        >>> make_continuous_sequence(seq, 7)
        [(0, [(0,0)]), (1, [(0,0)]), (2, [(1,1)]), (3, [(1,1)]), 
         (4, [(1,1)]), (5, [(2,2)]), (6, [(2,2)]), (7, [(2,2)])]
    """
    if not sequence:
        return []
    
    # 按 cycle 排序
    sorted_seq = sorted(sequence, key=lambda x: x[0])
    
    # 找到最小和最大的 cycle
    min_cycle = sorted_seq[0][0]
    
    # 构建连续序列
    continuous = []
    last_cells = None
    seq_idx = 0
    
    for cycle in range(min_cycle, max_cycle + 1):
        # 检查当前 cycle 是否在原始序列中
        if seq_idx < len(sorted_seq) and sorted_seq[seq_idx][0] == cycle:
            last_cells = sorted_seq[seq_idx][1]
            seq_idx += 1
        
        # 如果有 last_cells，添加到结果中
        if last_cells is not None:
            continuous.append((cycle, last_cells))
    
    return continuous
