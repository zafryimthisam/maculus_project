import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ViewStyle, TextStyle, Vibration } from 'react-native';

interface Props {
  title: string;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  color?: string;
}

export const AccessibleButton: React.FC<Props> = ({
  title,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  style,
  textStyle,
  color = '#2563EB',
}) => {
  const handlePress = () => {
    Vibration.vibrate(12); // subtle physical feedback for blind users
    onPress();
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={[styles.button, { backgroundColor: disabled ? '#9CA3AF' : color }, style]}
    >
      <Text style={[styles.text, textStyle]}>{title}</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    paddingVertical: 20,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginVertical: 8,
    minHeight: 64,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  text: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
});
